"""ArborFDM's Python Manifold API backed by the official manifold-3d WASM build.

This adapter contains no replacement support heuristics. It translates arrays,
transforms, method names, and ownership between the two official bindings.
"""
import numpy as np
from pyodide.ffi import to_js
from js import Object, Float32Array, Uint32Array
from manifold_js import api as _api

class Error:
    NoError = 'NoError'
class OpType:
    Add = 'union'
    Subtract = 'difference'
    Intersect = 'intersection'
class FillRule:
    EvenOdd = 'EvenOdd'
    Positive = 'Positive'
class JoinType:
    Miter = 'Miter'
    Round = 'Round'

def _plain(value):
    if isinstance(value, np.ndarray): return value.tolist()
    if isinstance(value, np.generic): return value.item()
    if isinstance(value, (list, tuple)): return [_plain(v) for v in value]
    if isinstance(value, dict): return {k: _plain(v) for k,v in value.items()}
    return value

def _js(value):
    return to_js(_plain(value), dict_converter=Object.fromEntries)

class Mesh:
    def __init__(self, vert_properties=None, tri_verts=None, _obj=None):
        if _obj is not None:
            self._obj = _obj
        else:
            self._obj = _api.Mesh.new(_js({
                'numProp': 3,
                'vertProperties': Float32Array.new(_js(np.asarray(vert_properties).ravel())),
                'triVerts': Uint32Array.new(_js(np.asarray(tri_verts).ravel())),
            }))
    @property
    def vert_properties(self):
        return np.asarray(self._obj.vertProperties.to_py()).reshape(-1, self._obj.numProp)
    @property
    def tri_verts(self):
        return np.asarray(self._obj.triVerts.to_py()).reshape(-1, 3)
    def merge(self):
        return self._obj.merge()

class _Solid:
    def __del__(self):
        obj = getattr(self, '_obj', None)
        if obj is not None:
            try: obj.delete()
            except Exception: pass
    @classmethod
    def _wrap(cls, obj):
        result = cls.__new__(cls)
        result._obj = obj
        return result
    def is_empty(self): return self._obj.isEmpty()
    def decompose(self): return [type(self)._wrap(o) for o in self._obj.decompose().to_py()]
    def __add__(self, other): return type(self)._wrap(self._obj.add(other._obj))
    def __sub__(self, other): return type(self)._wrap(self._obj.subtract(other._obj))
    def __xor__(self, other): return type(self)._wrap(self._obj.intersect(other._obj))
    @classmethod
    def batch_boolean(cls, solids, op):
        factory = _api.CrossSection if cls is CrossSection else _api.Manifold
        return cls._wrap(getattr(factory, op)(_js([s._obj for s in solids])))

class CrossSection(_Solid):
    def __init__(self, contours=None, fill_rule=FillRule.Positive):
        self._obj = (_api.CrossSection.union(_js([])) if contours is None or len(contours) == 0
                     else _api.CrossSection.new(_js(contours), fill_rule))
    def to_polygons(self): return self._obj.toPolygons().to_py()
    def area(self): return self._obj.area()
    def offset(self, delta, join_type=JoinType.Round, miter_limit=2.0, circular_segments=0):
        return self._wrap(self._obj.offset(float(delta), join_type, float(miter_limit), int(circular_segments)))

class Manifold(_Solid):
    def __init__(self, mesh=None):
        self._error = None
        try:
            self._obj = _api.Manifold.union(_js([])) if mesh is None else _api.Manifold.new(mesh._obj)
        except Exception as exc:
            # The JS binding throws for invalid topology; Python returns an
            # empty solid carrying an error status. Preserve Python semantics
            # so the upstream fallback slicer / tube fallback can still run.
            if 'ManifoldError' not in str(exc): raise
            self._error = str(exc)
            self._obj = _api.Manifold.union(_js([]))
    def status(self): return getattr(self, '_error', None) or self._obj.status()
    def volume(self): return self._obj.volume()
    def to_mesh(self): return Mesh(_obj=self._obj.getMesh())
    def slice(self, height): return CrossSection._wrap(self._obj.slice(float(height)))
    def translate(self, xyz): return self._wrap(self._obj.translate(_js(xyz)))
    def rotate(self, xyz): return self._wrap(self._obj.rotate(_js(xyz)))
    def transform(self, matrix):
        # Python: row-major 3x4. JS: column-major homogeneous 4x4.
        m = np.eye(4)
        m[:3, :] = np.asarray(matrix)
        return self._wrap(self._obj.transform(_js(m.T.ravel())))
    def trim_by_plane(self, normal, origin_offset):
        return self._wrap(self._obj.trimByPlane(_js(normal), float(origin_offset)))
    @classmethod
    def cylinder(cls, height, radius_low, radius_high=-1, circular_segments=0, center=False):
        return cls._wrap(_api.Manifold.cylinder(float(height), float(radius_low), float(radius_high), int(circular_segments), center))
    @classmethod
    def sphere(cls, radius, circular_segments=0):
        return cls._wrap(_api.Manifold.sphere(float(radius), int(circular_segments)))
    @classmethod
    def cube(cls, size=(1,1,1), center=False):
        return cls._wrap(_api.Manifold.cube(_js(size), center))
    @classmethod
    def batch_hull(cls, solids):
        return cls._wrap(_api.Manifold.hull(_js([s._obj for s in solids])))
    @classmethod
    def compose(cls, solids):
        return cls._wrap(_api.Manifold.compose(_js([s._obj for s in solids])))
    @classmethod
    def extrude(cls, cross_section, height):
        return cls._wrap(_api.Manifold.extrude(cross_section._obj, float(height)))
