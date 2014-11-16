/* @requires mapshaper-shape-geom */

// Get the centroid of the largest ring of a polygon
// TODO: Include holes in the calculation
// TODO: Add option to find centroid of all rings, not just the largest
geom.getShapeCentroid = function(shp, arcs) {
  var maxPath = geom.getMaxPath(shp, arcs);
  return maxPath ? geom.getPathCentroid(maxPath, arcs) : null;
};

geom.getPathCentroid = function(ids, arcs) {
  var iter = arcs.getShapeIter(ids),
      sum = 0,
      sumX = 0,
      sumY = 0,
      ax, ay, tmp, area;
  if (!iter.hasNext()) return null;
  ax = iter.x;
  ay = iter.y;
  while (iter.hasNext()) {
    tmp = ax * iter.y - ay * iter.x;
    sum += tmp;
    sumX += tmp * (iter.x + ax);
    sumY += tmp * (iter.y + ay);
    ax = iter.x;
    ay = iter.y;
  }
  area = sum / 2;
  if (area === 0) {
    return geom.getAvgPathXY(ids, arcs);
  } else return {
    x: sumX / (6 * area),
    y: sumY / (6 * area)
  };
};

// Find a point inside a polygon and located away from the polygon edge
// Method:
// - get the largest ring of the polygon
// - get an array of x-values evenly spaced along the horizontal extent of the ring
// - for each x:
//     intersect a vertical line with the polygon at x
//     find midpoints of each intersecting segment
// - for each midpoint:
//     adjust point vertically to maximize distance from polygon edge
// - return the adjusted point having the maximum weighted distance from the edge
//     (distance is weighted to slightly favor points near centroid)
//
geom.findInteriorPoint = function(shp, arcs) {
  var maxPath = geom.getMaxPath(shp, arcs),
      pathBounds = arcs.getSimpleShapeBounds(maxPath),
      NUM_TICS = 25,
      maxPathArea = geom.getPathArea4(maxPath, arcs),
      centroid;

  if (!pathBounds.hasBounds() || pathBounds.area() === 0) {
    return null;
  }

  centroid = geom.getPathCentroid(maxPath, arcs);

  // Use centroid if shape is simple and squarish
  if (shp.length == 1 && geom.getPathArea4(maxPath, arcs) * 1.3 > pathBounds.area()) {
    if (geom.testPointInShape(centroid.x, centroid.y, shp, arcs)) {
      return centroid;
    }
  }

  // Get candidate points, evenly spaced along x-axis
  var tics = MapShaper.getInnerTics(pathBounds.xmin, pathBounds.xmax, NUM_TICS);
  var allCands = tics.reduce(function(memo, x) {
    var cands = MapShaper.findHitCandidates(x, pathBounds.ymin - 1, shp, arcs);
    return memo.concat(cands);
  }, []);

  // Find a best-fit point
  var p = MapShaper.findBestInteriorPoint(allCands, shp, arcs, pathBounds, centroid);
  if (!p) {
    verbose("[findInteriorPoint()] failed, falling back to centroid");
    p = centroid;
  }
  return p;
};

// Receive an array of candidate points
// Return a best-fit point
MapShaper.findBestInteriorPoint = function(candidates, shp, arcs, pathBounds, centroid) {
  var vstep = pathBounds.height() / 25;
  var referenceDist = Math.max(pathBounds.width(), pathBounds.height()) / 2;
  var bestP, adjustedP, candP;

  // Sort candidates so points at the center of longer segments are tried first
  candidates.forEach(function(p) {
    p.interval *= getWeight(p.x, p.y);
  });
  candidates.sort(function(a, b) {
    return b.interval - a.interval;
  });

  for (var i=0; i<candidates.length; i++) {
    candP = candidates[i];
    // Optimization: Stop searching if weighted half-segment length of remaining
    //   points is less than the weighted edge distance of the best candidate
    if (bestP && bestP.distance > candP.interval) {
      break;
    }
    adjustedP = MapShaper.getAdjustedPoint(candP.x, candP.y, shp, arcs, vstep, getWeight);

    if (!bestP || adjustedP.distance > bestP.distance) {
      bestP = adjustedP;
    }
  }

  // Get a number for weighting a candidate point
  // Points closer to the centroid are slightly preferred
  function getWeight(x, y) {
    var offset = distance2D(centroid.x, centroid.y, x, y);
    return 1 - Math.min(0.4 * offset / referenceDist, 0.2);
  }

  return bestP;
};

// [x, y] is a point assumed to be inside a polygon @shp
// Try to move the point farther from the polygon edge
MapShaper.getAdjustedPoint = function(x, y, shp, arcs, vstep, weight) {
  var p = {
    x: x,
    y: y,
    distance: geom.getPointToShapeDistance(x, y, shp, arcs) * weight(x, y)
  };
  MapShaper.scanForBetterPoint(p, shp, arcs, vstep, weight); // scan up
  MapShaper.scanForBetterPoint(p, shp, arcs, -vstep, weight); // scan down
  return p;
};

// Try to find a better-fit point than @p by scanning vertically
// Modify p in-place
MapShaper.scanForBetterPoint = function(p, shp, arcs, vstep, weight) {
  var x = p.x,
      y = p.y,
      dmax = p.distance,
      d;

  while (true) {
    y += vstep;
    d = geom.getPointToShapeDistance(x, y, shp, arcs) * weight(x, y);
    // overcome vary small local minima
    if (d > dmax * 0.98 && geom.testPointInShape(x, y, shp, arcs)) {
      if (d > dmax) {
        p.distance = dmax = d;
        p.y = y;
      }
    } else {
      break;
    }
  }
};

// Return array of points at the midpoint of each line segment formed by the
//   intersection of a vertical ray at [x, y] and a polygon shape
MapShaper.findHitCandidates = function(x, y, shp, arcs) {
  var yy = MapShaper.findRayShapeIntersections(x, y, shp, arcs);
  var cands = [], y1, y2, interval;

  // sortying by y-coord organizes y-intercepts into interior segments
  utils.genericSort(yy);
  for (var i=0; i<yy.length; i+=2) {
    y1 = yy[i];
    y2 = yy[i+1];
    interval = (y2 - y1) / 2;
    if (interval > 0) {
      cands.push({
        y: (y1 + y2) / 2,
        x: x,
        interval: interval
      });
    }
  }
  return cands;
};

// Return array of y-intersections between vertical ray with origin at [x, y]
//   and a polygon
MapShaper.findRayShapeIntersections = function(x, y, shp, arcs) {
  if (!shp) return [];
  return shp.reduce(function(memo, path) {
    var yy = MapShaper.findRayRingIntersections(x, y, path, arcs);
    return memo.concat(yy);
  }, []);
};

// Return array of y-intersections between vertical ray and a polygon ring
MapShaper.findRayRingIntersections = function(x, y, path, arcs) {
  var yints = [];
  MapShaper.forEachPathSegment(path, arcs, function(a, b, xx, yy) {
    var result = geom.getRayIntersection(x, y, xx[a], yy[a], xx[b], yy[b]);
    if (result > -Infinity) {
      yints.push(result);
    }
  });
  // Ignore odd number of intersections -- probably caused by a ray that touches
  //   but doesn't cross the ring
  // TODO: improve method to handle edge case with two touches and no crosses.
  if (yints.length % 2 === 1) {
    yints = [];
  }
  return yints;
};

// TODO: find better home + name for this
MapShaper.getInnerTics = function(min, max, steps) {
  var range = max - min,
      step = range / (steps + 1),
      arr = [];
  for (var i = 1; i<=steps; i++) {
    arr.push(min + step * i);
  }
  return arr;
};
