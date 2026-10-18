#!/usr/bin/env python3
"""Verify every oriented original-model triangle in an editable Bambu 3MF.

Usage: python3 scripts/research-original-geometry.py PAIR_DIR EDITABLE.3mf
       python3 scripts/research-original-geometry.py --self-test

The expected mesh is each manifest model.stl, translated by its plate placement.
Face order, vertex indexing and cyclic face rotations may change. Coordinates,
face multiplicity and winding must survive within 0.00002 mm per coordinate.
This is a geometry provenance check, not a printability or support-coverage test.
Requires NumPy; reads private geometry in place without copying it into source.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import io
import itertools
import json
from pathlib import Path
import posixpath
import re
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

import numpy as np

TOLERANCE_MM = 0.00002
NS = {"c": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}
PRODUCTION = "{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}"
ROOT_MODEL = "3D/3dmodel.model"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stl_triangles(data):
    """Read actual stored coordinates; do not weld, simplify or repair faces."""
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if 84 + 50 * count == len(data):
            dtype = np.dtype([("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
            triangles = np.frombuffer(data, dtype=dtype, count=count, offset=84)["vertices"].astype(np.float64)
            assert np.isfinite(triangles).all(), "Non-finite original STL coordinates"
            return triangles
    text = data.decode("ascii")
    numbers = re.findall(r"\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)", text)
    triangles = np.asarray(numbers, dtype=np.float64).reshape(-1, 3, 3)
    assert len(triangles) and np.isfinite(triangles).all(), "Invalid ASCII STL"
    return triangles


def compare_triangles(expected, actual, tolerance=TOLERANCE_MM):
    """Injective full-coordinate face match, permitting only cyclic rotations.

    The common ordered case is vectorized. Reordered faces use centroid buckets,
    then compare all nine coordinates, never rounded-coordinate equality. A
    bipartite augmenting search handles duplicate/near-coincident candidate faces
    without reusing any source face. Winding reversal is never an allowed match.
    """
    base = {"triangleCount": len(actual), "expectedTriangleCount": len(expected),
            "matchedTriangles": 0, "maxCoordinateDifferenceMm": None,
            "orientedFacesPreserved": False, "passed": False}
    if expected.shape != actual.shape or not len(expected):
        return {**base, "failure": "Original face count changed or original is empty"}
    if not np.isfinite(expected).all() or not np.isfinite(actual).all():
        return {**base, "failure": "Non-finite geometry coordinates"}
    errors = np.minimum.reduce([np.max(np.abs(actual - np.roll(expected, shift, axis=1)), axis=(1, 2))
                                for shift in range(3)])
    if np.all(errors <= tolerance):
        return {**base, "matchedTriangles": len(actual), "maxCoordinateDifferenceMm": float(errors.max()),
                "orientedFacesPreserved": True, "passed": True, "matching": "ordered oriented triangles"}

    source_cells = np.floor(expected.mean(axis=1) / tolerance).astype(np.int64)
    actual_cells = np.floor(actual.mean(axis=1) / tolerance).astype(np.int64)
    buckets = defaultdict(list)
    for index, cell in enumerate(source_cells):
        buckets[tuple(cell)].append(index)
    neighbors = tuple(itertools.product((-1, 0, 1), repeat=3))
    source_owner = np.full(len(expected), -1, dtype=np.int64)
    actual_match = np.full(len(actual), -1, dtype=np.int64)
    candidate_cache = {}

    def candidates(index):
        if index in candidate_cache:
            return candidate_cache[index]
        cell = actual_cells[index]
        ids = [i for delta in neighbors for i in buckets.get(tuple(cell + delta), ())]
        if not ids:
            return []
        faces = expected[ids]
        differences = np.minimum.reduce([np.max(np.abs(actual[index] - np.roll(faces, shift, axis=1)), axis=(1, 2))
                                         for shift in range(3)])
        result = sorted((float(error), int(i)) for i, error in zip(ids, differences) if error <= tolerance)
        # Cache only contested candidates; the normal unique-face path stays small.
        if len(result) > 1:
            candidate_cache[index] = result
        return result

    for index in range(len(actual)):
        options = candidates(index)
        free = next((i for _, i in options if source_owner[i] < 0), None)
        if free is not None:
            source_owner[free] = index
            actual_match[index] = free
            continue
        # BFS finds an augmenting path without recursion-depth assumptions.
        queue = [index]
        previous = {index: None}
        seen_sources = set()
        ending = None
        for current in queue:
            for _, source in candidates(current):
                if source in seen_sources:
                    continue
                seen_sources.add(source)
                owner = int(source_owner[source])
                if owner < 0:
                    ending = (current, source)
                    break
                if owner not in previous:
                    previous[owner] = (current, source)
                    queue.append(owner)
            if ending is not None:
                break
        if ending is None:
            return {**base, "matchedTriangles": index, "firstUnmatchedTriangle": index,
                    "failure": "No one-to-one oriented triangle-coordinate match within tolerance"}
        current, source = ending
        while True:
            source_owner[source] = current
            actual_match[current] = source
            if previous[current] is None:
                break
            current, source = previous[current]
    matched = expected[actual_match]
    error = np.minimum.reduce([np.max(np.abs(actual - np.roll(matched, shift, axis=1)), axis=(1, 2))
                               for shift in range(3)])
    assert np.all(error <= tolerance) and len(np.unique(actual_match)) == len(expected)
    return {**base, "matchedTriangles": len(actual), "maxCoordinateDifferenceMm": float(error.max()),
            "orientedFacesPreserved": True, "passed": True, "matching": "one-to-one oriented triangle multiset"}


def matrix(text=None):
    result = np.eye(4)
    if text:
        values = np.asarray(text.split(), dtype=np.float64)
        assert values.shape == (12,) and np.isfinite(values).all(), "Invalid 3MF transform"
        result[:3, :3] = values[:9].reshape(3, 3)
        result[3, :3] = values[9:]
    return result


class GeometryArchive:
    def __init__(self, archive_bytes):
        self.zip = zipfile.ZipFile(io.BytesIO(archive_bytes))
        self.documents = {}

    def document(self, filename):
        if filename not in self.documents:
            doc = ET.fromstring(self.zip.read(filename))
            assert doc.attrib.get("unit", "millimeter") == "millimeter", "Only millimeter geometry is accepted"
            self.documents[filename] = (doc, {o.attrib["id"]: o for o in doc.findall("c:resources/c:object", NS)})
        return self.documents[filename]

    @staticmethod
    def component_path(current, element):
        name = element.attrib.get(PRODUCTION + "path")
        if name is None:
            return current
        result = posixpath.normpath(name.lstrip("/") if name.startswith("/") else posixpath.join(posixpath.dirname(current), name))
        assert not result.startswith("../"), "Invalid component archive path"
        return result

    def triangles(self, filename, object_id, transform, ancestors=()):
        key = (filename, object_id)
        assert key not in ancestors, "Cyclic 3MF component reference"
        obj = self.document(filename)[1][object_id]
        mesh = obj.find("c:mesh", NS)
        components = obj.findall("c:components/c:component", NS)
        assert (mesh is None) != (len(components) == 0), "Expected exactly one mesh or a component collection"
        if mesh is not None:
            vertices = np.asarray([[float(v.attrib[a]) for a in "xyz"] for v in mesh.findall("c:vertices/c:vertex", NS)])
            faces = np.asarray([[int(t.attrib[a]) for a in ("v1", "v2", "v3")] for t in mesh.findall("c:triangles/c:triangle", NS)])
            assert vertices.ndim == 2 and vertices.shape[1] == 3 and len(faces), "Empty/invalid original 3MF mesh"
            assert faces.min() >= 0 and faces.max() < len(vertices), "Invalid original triangle indices"
            positioned = vertices @ transform[:3, :3] + transform[3, :3]
            assert np.isfinite(positioned).all(), "Non-finite transformed 3MF coordinates"
            return positioned[faces]
        return np.concatenate([self.triangles(self.component_path(filename, c), c.attrib["objectid"],
                                             matrix(c.attrib.get("transform")) @ transform, ancestors + (key,))
                               for c in components])


def metadata(element):
    return {m.attrib["key"]: m.attrib.get("value") for m in element.findall("metadata") if "key" in m.attrib}


def audit(folder, project, expected_count):
    manifest_bytes = (folder / "plate-manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    project_bytes = project.read_bytes()
    archive = GeometryArchive(project_bytes)
    root, resources = archive.document(ROOT_MODEL)
    config = ET.fromstring(archive.zip.read("Metadata/model_settings.config"))
    builds = defaultdict(list)
    for item in root.findall("c:build/c:item", NS):
        builds[item.attrib["objectid"]].append(item)
    objects = defaultdict(list)
    for obj in config.findall("object"):
        objects[metadata(obj).get("name")].append(obj)
    expected = [(s, m) for s in manifest["specimens"] for m in s["meshes"] if Path(m["path"]).name == "model.stl"]
    assert len(expected) == expected_count, f"Expected {expected_count} original model meshes; manifest has {len(expected)}"
    assert len({s["assemblyIndex"] for s, _ in expected}) == expected_count, "Original assemblies must be distinct"
    assembly_ids = []
    for specimen in manifest["specimens"]:
        entries = objects[f'assemble_{specimen["assemblyIndex"]}']
        assert len(entries) == 1, "Missing/duplicate manifest assembly"
        assembly_ids.append(entries[0].attrib["id"])
    assert set(builds) == set(assembly_ids) and all(len(items) == 1 for items in builds.values()), "Unmanifested or duplicated build instance"
    rows = []
    for specimen, original in expected:
        name = f'assemble_{specimen["assemblyIndex"]}'
        assert len(objects[name]) == 1, f"Missing/duplicate metadata assembly {name}"
        obj = objects[name][0]
        obj_id = obj.attrib["id"]
        assert len(builds[obj_id]) == 1, f"Original assembly {name} must have exactly one build instance"
        item = builds[obj_id][0]
        assert item.attrib.get("printable", "1") == "1", f"Original assembly {name} is not printable"
        assert archive.component_path(ROOT_MODEL, item) == ROOT_MODEL, "Unexpected external root assembly"
        parts = [p for p in obj.findall("part") if metadata(p).get("source_file") == "model.stl"]
        assert len(parts) == 1, f"Original {name} must have one model.stl metadata part"
        part = parts[0]
        components = [c for c in resources[obj_id].findall("c:components/c:component", NS) if c.attrib["objectid"] == part.attrib["id"]]
        assert len(components) == 1, f"Original {name} must resolve to one actual component"
        component = components[0]
        transform = matrix(component.attrib.get("transform")) @ matrix(item.attrib.get("transform"))
        actual = archive.triangles(archive.component_path(ROOT_MODEL, component), component.attrib["objectid"], transform)
        source_path = Path(original["path"])
        source_bytes = source_path.read_bytes()
        source_hash = sha(source_bytes)
        original_triangles = stl_triangles(source_bytes)
        translation = np.asarray(specimen["translation"], dtype=np.float64)
        assert translation.shape == (3,) and np.isfinite(translation).all(), "Invalid expected plate translation"
        result = compare_triangles(original_triangles + translation, actual)
        source_unchanged = source_hash == original["sha256"]
        result["passed"] = result["passed"] and source_unchanged and len(original_triangles) == original["triangles"]
        rows.append({"specimen": specimen["id"], "part": "model.stl", "assemblyObjectId": obj_id,
                     "partId": part.attrib["id"], "sourcePath": str(source_path.resolve()),
                     "sourceSha256": source_hash, "manifestSourceSha256": original["sha256"],
                     "sourceHashUnchanged": source_unchanged, "plateTranslationMm": translation.tolist(), **result})
    # A duplicate or unbound original metadata part must not silently escape this audit.
    archive_original_count = sum(metadata(p).get("source_file") == "model.stl" for o in config.findall("object") for p in o.findall("part"))
    assert archive_original_count == expected_count, "Unbound/duplicate original metadata part in archive"
    return {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
            "inputProject": str(project.resolve()), "inputSha256": sha(project_bytes),
            "manifestSha256": sha(manifest_bytes), "toleranceMm": TOLERANCE_MM,
            "expectedOriginalCount": expected_count, "originalCount": len(rows),
            "passed": all(r["passed"] for r in rows),
            "maxCoordinateDifferenceMm": max(r["maxCoordinateDifferenceMm"] for r in rows) if all(r["maxCoordinateDifferenceMm"] is not None for r in rows) else None,
            "method": "All source triangle coordinates after plate translation versus all 3MF triangle coordinates after component and build transforms; one-to-one oriented faces, cyclic rotations allowed, no winding reversal, no mesh repair.",
            "originals": rows}


def self_test():
    # A box-like surface with a non-extreme vertex: bounding boxes cannot detect its mutation.
    vertices = np.array([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [1, 1, .5], [0, 0, 2]], dtype=float)
    faces = np.array([[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [0, 5, 1]])
    source = vertices[faces]
    reordered = np.roll(source[[3, 1, 4, 0, 2]], 1, axis=1)
    assert compare_triangles(source, reordered)["passed"]
    changed = vertices.copy()
    changed[4, 2] += .01
    altered = changed[faces]
    assert np.array_equal(altered.min(axis=(0, 1)), source.min(axis=(0, 1)))
    assert np.array_equal(altered.max(axis=(0, 1)), source.max(axis=(0, 1)))
    assert not compare_triangles(source, altered)["passed"], "Same-bounds internal mutation must fail"
    reversed_face = source.copy()
    reversed_face[0] = reversed_face[0, [0, 2, 1]]
    assert not compare_triangles(source, reversed_face)["passed"], "Reversed winding must fail"
    assert compare_triangles(source, reordered + TOLERANCE_MM * .4)["passed"]
    assert not compare_triangles(source, reordered + TOLERANCE_MM * 2)["passed"]
    assert not compare_triangles(source, source[:-1])["passed"]
    duplicate = source.copy()
    duplicate[0] = duplicate[1]
    assert not compare_triangles(source, duplicate)["passed"], "Face multiplicity must survive"
    # Force a contested tolerance match requiring reassignment, not greedy reuse.
    triangle = np.array([[[0., 0, 0], [1., 0, 0], [0., 1, 0]]])
    expected = np.concatenate([triangle, triangle + [TOLERANCE_MM * 1.5, 0, 0]])
    actual = np.concatenate([triangle + [TOLERANCE_MM * .6, 0, 0], triangle - [TOLERANCE_MM * .5, 0, 0]])
    assert compare_triangles(expected, actual)["passed"]
    # Non-commuting child rotation / build translation confirms transform order.
    child = matrix("0 1 0 -1 0 0 0 0 1 0 0 0")
    build = matrix("1 0 0 0 1 0 0 0 1 10 20 30")
    composed = child @ build
    assert np.array_equal(np.array([1, 0, 0, 1]) @ composed, [10, 21, 30, 1])
    print("Original geometry self-test passed: reordered/cyclic faces, internal vertex mutation with equal bounds, winding, tolerance, missing/duplicate faces, ambiguous assignment, transforms.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, nargs="?")
    parser.add_argument("project", type=Path, nargs="?")
    parser.add_argument("--expected-originals", type=int, default=2)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.folder is None or args.project is None or args.expected_originals <= 0:
        parser.error("PAIR_DIR, EDITABLE.3mf and a positive expected original count are required")
    report = audit(args.folder, args.project, args.expected_originals)
    output = args.output or args.folder / "gui-sliced/original-geometry.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"output": str(output), **{k: report[k] for k in ("passed", "originalCount", "toleranceMm", "maxCoordinateDifferenceMm", "inputSha256")}}, indent=2))
    if not report["passed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
