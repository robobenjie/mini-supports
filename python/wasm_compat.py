"""NumPy compatibility for a wasm32 host (np.intp is 32-bit).

Desktop ArborFDM intentionally uses int64 mesh indices. NumPy repeat/bincount
require intp arrays on wasm32. Cast only integer index/count arrays, after checking
for overflow; retain NumPy's normal validation for other types. No geometry or
support parameters are changed.
"""
import numpy as np

_repeat = np.repeat
_bincount = np.bincount

def _index_array(values):
    a = np.asarray(values)
    if a.dtype.kind in 'iu' and a.dtype != np.dtype(np.intp):
        limit = np.iinfo(np.intp)
        if a.size and (np.min(a) < limit.min or np.max(a) > limit.max):
            raise ValueError('Mesh exceeds the browser index capacity.')
        return a.astype(np.intp)
    return values

def repeat(a, repeats, axis=None):
    return _repeat(a, _index_array(repeats), axis=axis)

def bincount(x, weights=None, minlength=0):
    return _bincount(_index_array(x), weights=weights, minlength=minlength)

if np.dtype(np.intp).itemsize == 4:
    np.repeat = repeat
    np.bincount = bincount
