"""Engine entry points. The GUI and the CLI only talk to the engine through this module.

Stages (each in its own module, testable alone):
  analysis.analyze      -> AnalysisResult        (layer by layer slicing, islands, overhangs)
  contacts.place_contacts -> list[Contact]       (where tips touch the model, with reasons)
  patch_first.plan_patches -> PatchPlan          (negative roofs and support terminals)
  tree.build_tree       -> SupportTree           (tips -> branches -> trunks -> feet)
  patch_first.attach_patches -> SupportTree      (retain roofs with routed terminals)
  build.mesh_tree       -> trimesh.Trimesh       (manifold union of all support solids)
  build.mesh_raft       -> trimesh.Trimesh|None
  verify.verify         -> list[Issue]           (post generation checks)
  verify.support_stats  -> dict                  (GenerationResult.stats: volume, mass, marks...)
"""
from __future__ import annotations

import dataclasses
import time
from typing import Optional

import numpy as np
import trimesh

from . import analysis as _analysis
from . import build as _build
from . import contacts as _contacts
from . import placement as _placement
from . import tree as _tree
from . import verify as _verify
from .params import SupportParams, model_on_raft
from .types import AnalysisResult, Contact, GenerationResult, Issue, Progress


# Largest model extent accepted (mm). Desktop FDM build volumes are <= ~500 mm; anything
# larger is almost always a unit or scale mistake and would exhaust memory (QA-8).
MAX_MODEL_EXTENT_MM = 1000.0


def check_model_size(mesh: trimesh.Trimesh) -> None:
    if len(mesh.vertices) == 0:
        raise ValueError("The model is empty")
    ext = float(max(mesh.extents))
    if ext > MAX_MODEL_EXTENT_MM:
        raise ValueError(f"The model is {ext:.0f} mm long, larger than {MAX_MODEL_EXTENT_MM:.0f} mm: "
                         "check the units or the scale before generating supports")


def analyze(mesh: trimesh.Trimesh, params: SupportParams,
            progress: Optional[Progress] = None) -> AnalysisResult:
    return _analysis.analyze(mesh, params, progress or Progress())


def generate(mesh: trimesh.Trimesh, params: SupportParams,
             manual_contacts: Optional[list[Contact]] = None,
             progress: Optional[Progress] = None,
             analysis: Optional[AnalysisResult] = None,
             contacts: Optional[list[Contact]] = None) -> GenerationResult:
    """Full generation.

    analysis: reuse a previous analysis (same mesh + detection params; ignored if it
              was computed with another model lift).
    contacts: if given, skip automatic placement and use exactly these contacts
              (used after manual editing: 'regenerate branches only').

    Everything returned is in the frame of `mesh` (the model is never moved). With a
    raft under the model the raft lies below z = 0 and, when the model is lifted
    (placement.plan_lift), so do the supports; see GenerationResult.model_lift/plate_z.
    """
    progress = progress or Progress()
    problems = params.validate()
    if problems:
        raise ValueError("Invalid parameters: " + "; ".join(problems))
    check_model_size(mesh)
    mesh, mesh_repair = _build.prepare_analysis_mesh(mesh)
    plan = _placement.plan_lift(mesh, params)
    L = float(plan.lift)
    if analysis is not None and abs(float(analysis.stats.get("model_lift", 0.0)) - L) > 1e-9:
        analysis = None                      # computed for another placement
    if L <= 0.0:
        res = _generate(mesh, params, manual_contacts, progress, analysis, contacts)
    else:
        up = np.array([0.0, 0.0, L])
        mesh_e = mesh.copy()
        mesh_e.apply_translation(up)
        # caller's contacts: moved in place for the run and restored exactly afterwards
        # (the tree builder sets rests_on_model on these objects)
        given = list({id(c): c for c in (manual_contacts or []) + (contacts or [])}.values())
        saved = {id(c): c.position for c in given}
        for c in given:
            c.position = np.asarray(c.position, float) + up
        try:
            res = _generate(mesh_e, params, manual_contacts, progress,
                            _shift_analysis(analysis, L) if analysis is not None else None, contacts)
        finally:
            for c in given:
                c.position = saved[id(c)]
        _shift_result(res, -L, skip={id(c) for c in given})
    res.model_lift = L
    res.plate_z = (-(float(params.raft_thickness) + float(params.raft_release_gap) + L)
                   if model_on_raft(params) else 0.0)
    res.analysis.stats["model_lift"] = L
    res.stats["model_lift_mm"] = L
    res.stats["plate_z_mm"] = res.plate_z
    res.stats["lift_plan"] = plan.as_dict()
    if mesh_repair:
        res.stats['analysis_mesh_repair'] = mesh_repair
    if L > 0:
        res.issues.append(Issue("info", "model_lifted", "Model raised above the raft: " + plan.reason,
                                np.array([*mesh.bounds.mean(axis=0)[:2], float(mesh.bounds[0][2])])))
    elif plan.refused:
        res.issues.append(Issue("warning", "raft_lift_refused",
                                "Overhangs close to the raft keep short supports: " + plan.reason,
                                np.array([*mesh.bounds.mean(axis=0)[:2], float(mesh.bounds[0][2])])))
    by = res.stats.get("issues_by_code")
    if isinstance(by, dict) and res.issues and res.issues[-1].code in ("model_lifted", "raft_lift_refused"):
        by[res.issues[-1].code] = by.get(res.issues[-1].code, 0) + 1
    return res


def _shift_analysis(a: AnalysisResult, dz: float) -> AnalysisResult:
    """Copy of an analysis translated by dz along Z (XY polygons and face mask unchanged)."""
    sh = lambda p: np.asarray(p, float) + np.array([0.0, 0.0, dz])
    regions = [dataclasses.replace(r, z=float(r.z) + dz) for r in a.regions]
    corners = sh(a.corners).reshape(-1, 3) if len(a.corners) else a.corners
    lows = sh(a.low_points).reshape(-1, 3) if len(a.low_points) else a.low_points
    stats = dict(a.stats)
    if "z_min" in stats:
        stats["z_min"] = float(stats["z_min"]) + dz
    return dataclasses.replace(a, layer_z=np.asarray(a.layer_z, float) + dz, regions=regions,
                               hanging_edges=[(sh(p), sh(q)) for p, q in a.hanging_edges],
                               corners=corners, low_points=lows, stats=stats)


def _shift_mesh(m, dz: float):
    if m is None or len(getattr(m, "vertices", [])) == 0:
        return m
    out = m.copy()
    out.apply_translation((0.0, 0.0, dz))
    return out


def _shift_result(res: GenerationResult, dz: float, skip: set) -> None:
    """Translate a GenerationResult by dz (engine frame -> user frame), in place.
    Contacts whose id() is in skip already are in the user frame (restored by the caller)."""
    up = np.array([0.0, 0.0, dz])
    res.support_mesh = _shift_mesh(res.support_mesh, dz)
    res.raft_mesh = _shift_mesh(res.raft_mesh, dz)
    for c in res.contacts:
        if id(c) not in skip:
            c.position = np.asarray(c.position, float) + up
    t = res.tree
    if hasattr(t, "patch_solids"):
        t.patch_solids = [s.translate(up) for s in t.patch_solids]
        for record in t.patch_report:
            if record.get("status") == "built":
                record["anchor"] = [*record["anchor"][:2], record["anchor"][2] + dz]
                if "anchors" in record:
                    record["anchors"] = [[*a[:2], a[2] + dz] for a in record["anchors"]]
                if record.get("grip"):
                    record["grip"]["bounds"][2] += dz
                    record["grip"]["bounds"][5] += dz
                record["bounds"][2] += dz
                record["bounds"][5] += dz
    for record in getattr(t, "patch_release_report", []):
        for ribbon in record.get("ribbons", []):
            ribbon["bounds"][2] += dz
            ribbon["bounds"][5] += dz
            for stem in ribbon["stems"]:
                for key in ("neckBottom", "gripBottom", "fanBottom"):
                    stem[key] += dz
    if hasattr(t, "tip_keepout"):
        t.tip_keepout = t.tip_keepout.translate(up)
    if hasattr(t, "patch_contact_keepouts"):
        t.patch_contact_keepouts = [s.translate(up) for s in t.patch_contact_keepouts]
    if hasattr(t, "patch_terminal_top_z"):
        t.patch_terminal_top_z = {cid: z + dz for cid, z in t.patch_terminal_top_z.items()}
    for n in t.nodes.values():
        n.position = n.position + up
    if hasattr(t, "braces"):
        t.braces = [(np.asarray(p0, float) + up, np.asarray(p1, float) + up, rb) for p0, p1, rb in t.braces]
    if hasattr(t, "z_base"):
        t.z_base = float(t.z_base) + dz
    for i in res.issues:
        if i.position is not None:
            i.position = np.asarray(i.position, float) + up
    res.analysis = _shift_analysis(res.analysis, dz)


def _generate(mesh, params, manual_contacts, progress, analysis, contacts) -> GenerationResult:
    timings: dict[str, float] = {}

    t = time.perf_counter()
    if analysis is None:
        analysis = _analysis.analyze(mesh, params, progress.sub(0.0, 0.35))
    timings["analysis"] = time.perf_counter() - t

    t = time.perf_counter()
    if contacts is None:
        contacts = _contacts.place_contacts(mesh, analysis, params, manual_contacts or [],
                                            progress.sub(0.35, 0.45))
        if params.underside_patches:
            from .patches import add_corner_contacts
            contacts = add_corner_contacts(mesh, analysis, contacts, params)
    timings["contacts"] = time.perf_counter() - t

    t = time.perf_counter()
    active = [c for c in contacts if c.enabled]
    requested_params = params
    auto_split = params.underside_patches and params.removal_groups and params.raft_split and params.raft_split_auto
    if auto_split:
        params = params.updated(removal_groups=False, raft_split=False)
    patch_plan = None
    patch_planning_passes = []
    patch_routing_seconds = 0.
    if params.underside_patches:
        from .patch_first import plan_patches, attach_patches
        patch_plan = plan_patches(mesh, contacts, params, progress.sub(.45, .61))
        patch_planning_passes.append(dict(patch_plan.report))
    route_start = time.perf_counter()
    routing_contacts = active + ([p.terminal for p in patch_plan.patches] if patch_plan else [])
    tree = _tree.build_tree(mesh, routing_contacts, params,
                           progress.sub(.61 if patch_plan else .45, .7))
    patch_routing_seconds += time.perf_counter() - route_start
    if patch_plan is not None:
        attach_patches(tree, patch_plan, mesh, params)
    timings["tree"] = time.perf_counter() - t

    t = time.perf_counter()
    support_mesh = _build.mesh_tree(tree, params, progress.sub(0.7, 0.82 if auto_split else 0.92))
    if auto_split:
        from .raft_split import upward_removal_check
        progress.update(.82, "Checking whether supports obstruct upward removal")
        cage = upward_removal_check(mesh, support_mesh, params, progress.sub(.82, .86))
        if cage["needed"]:
            params = requested_params
            # Keep planned crowns wholly outside the split corridor. Only
            # surfaces crossing it need new fans; their exact skins and surface
            # samples are already available from the unsplit planning pass.
            patch_plan = plan_patches(mesh, contacts, params, progress.sub(.86, .90), previous=patch_plan)
            patch_planning_passes.append(dict(patch_plan.report))
            routing_contacts = active + [p.terminal for p in patch_plan.patches]
            route_start = time.perf_counter()
            tree = _tree.build_tree(mesh, routing_contacts, params, progress.sub(.90, .92))
            patch_routing_seconds += time.perf_counter() - route_start
            attach_patches(tree, patch_plan, mesh, params)
            support_mesh = _build.mesh_tree(tree, params, progress.sub(.92, .96))
        else:
            tree.raft_split_report = dict(status="skipped", reason="Upward removal has no significant sampled obstruction")
        tree.upward_removal_report = cage
    raft_mesh = _build.mesh_raft(tree, params) if params.raft_enabled else None
    if params.raft_split:
        from .raft_split import finalize_split
        if not finalize_split(tree, params, support_mesh, raft_mesh):
            tree.braces = list(getattr(tree, "_raft_split_original_braces", tree.braces))
            support_mesh = _build.mesh_tree(tree, params, progress.sub(.96, .97) if auto_split else progress.sub(.92, .94))
            raft_mesh = _build.mesh_raft(tree, params) if params.raft_enabled else None
    from .patch_release import release_patches, divide_large_raft, remove_unused_raft_parts
    support_mesh = release_patches(mesh, active, tree, support_mesh, raft_mesh, requested_params, progress.sub(.96, .98))
    raft_mesh = getattr(tree, "release_raft_mesh", raft_mesh)
    raft_mesh, support_mesh, tree.raft_size_report = divide_large_raft(raft_mesh, support_mesh, requested_params)
    raft_mesh, tree.raft_cleanup_report = remove_unused_raft_parts(raft_mesh, support_mesh, mesh, requested_params)
    timings["mesh"] = time.perf_counter() - t

    t = time.perf_counter()
    issues: list[Issue] = _verify.verify(mesh, analysis, contacts, tree, support_mesh,
                                         params, progress.sub(.97 if auto_split else .94, 1.0))
    stats = _verify.support_stats(mesh, contacts, tree, support_mesh, raft_mesh, issues, params)
    stats["patch_release"] = getattr(tree, "patch_release_report", [])
    stats["raft_size_split"] = getattr(tree, "raft_size_report", {})
    stats["raft_cleanup"] = tree.raft_cleanup_report
    if auto_split:
        stats["upward_removal"] = tree.upward_removal_report
    if params.underside_patches:
        stats["underside_patches"] = getattr(tree, "patch_report", [])
        stats["patch_first"] = {**getattr(tree, "patch_first_report", {}),
            "planningSeconds": sum(p["seconds"] for p in patch_planning_passes),
            "routingSeconds": patch_routing_seconds, "planningPasses": patch_planning_passes}
        stats["microbridge_contacts_omitted"] = analysis.stats.get("microbridge_contacts_omitted", [])
        stats["microledge_contacts_omitted"] = analysis.stats.get("microledge_contacts_omitted", [])
    if requested_params.raft_split:
        split = getattr(tree, "raft_split_report", {})
        stats["raft_split_applied"] = int(split.get("status") == "applied")
        stats["raft_split_gap_mm"] = float(split.get("gap", 0.0))
    timings["verify"] = time.perf_counter() - t
    progress.update(1.0, "Done")
    return GenerationResult(contacts, tree, support_mesh, raft_mesh, issues, analysis, timings, stats)
