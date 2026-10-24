"""Optional bulk JS sampler. Native Python keeps the existing implementation.

The engine's VerticalCaster.accelerator hook owns fallback behavior. Geometry
arrays cross the bridge once when the caster is built, then rays/results cross
in batches. No cross-language callback is made per triangle/ray.
"""
import weakref

import numpy as np


def install():
    try:
        from pyodide.ffi import to_js
        import support_sampler_js as bridge
    except ImportError:
        return False
    from arbor.engine.contacts import VerticalCaster

    class AcceleratedCaster:
        def __init__(self, mesh, reference):
            # The original KD-tree small faces win exact-height ties ahead of
            # its separate large-face pass. Preserve this for surface labels,
            # independently of the JS grid's own large-triangle partition.
            order = reference.fid[np.r_[reference.small, reference.large]]
            priority = np.full(len(mesh.faces), len(mesh.faces), dtype=np.int32)
            priority[order] = np.arange(len(order), dtype=np.int32)
            self.ident = bridge.create(
                to_js(np.ascontiguousarray(mesh.vertices, dtype=np.float64).ravel()),
                to_js(np.ascontiguousarray(mesh.faces, dtype=np.uint32).ravel()),
                to_js(np.ascontiguousarray(mesh.face_normals, dtype=np.float64).ravel()),
                to_js(priority))
            self._finalizer = weakref.finalize(self, bridge.destroy, self.ident)

        def cast(self, points, tol=1e-6):
            points = np.ascontiguousarray(points, dtype=np.float64).reshape(-1, 3)
            result = bridge.query(self.ident, to_js(points.ravel()), float(tol))
            return (np.asarray(result.z.to_py(), dtype=np.float64),
                    np.asarray(result.ids.to_py(), dtype=np.int64))

    VerticalCaster.accelerator = AcceleratedCaster
    return True
