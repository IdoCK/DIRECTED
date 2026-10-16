// Exact 2D nearest-sample lookup. Preserve the old linear scan's first-index tie
// breaking, including duplicate endpoints on closed curves.
export function createNearestCurvePoint(points) {
    function build(indices, depth) {
        if (!indices.length) return null;
        const axis = depth % 2 === 0 ? 'x' : 'y';
        indices.sort((a, b) => points[a][axis] - points[b][axis] || a - b);
        const middle = indices.length >> 1;
        return {
            index: indices[middle], axis,
            left: build(indices.slice(0, middle), depth + 1),
            right: build(indices.slice(middle + 1), depth + 1),
        };
    }
    const root = build(points.map((_, index) => index), 0);
    let best, bestDistance, queryX, queryY;
    function visit(node) {
        if (!node) return;
        const point = points[node.index];
        const dx = queryX - point.x, dy = queryY - point.y;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance || (distance === bestDistance && node.index < best)) {
            best = node.index;
            bestDistance = distance;
        }
        const delta = node.axis === 'x' ? dx : dy;
        visit(delta <= 0 ? node.left : node.right);
        if (delta * delta <= bestDistance) visit(delta <= 0 ? node.right : node.left);
    }
    return (x, y) => {
        best = 0; bestDistance = Infinity; queryX = x; queryY = y;
        visit(root);
        return best;
    };
}
