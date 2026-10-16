// Interpolation service for Pi-side calculation
class InterpolationService {
    constructor() {
        this.smoothFactor = 0.8;
    }

    setSmoothFactor(value) {
        this.smoothFactor = value;
    }

    // Server-side interpolation calculation
    interpolateLayersBatch(firstLayerData, secondLayerData, layerIndices) {
        console.log(`[INTERPOLATION] Pi processing ${layerIndices.length} layers`);
        const startTime = performance.now();
        
        if (!firstLayerData || !secondLayerData || !firstLayerData.points || !secondLayerData.points) {
            console.warn('[INTERPOLATION] Invalid layer data received');
            return [];
        }

        const results = [];
        const numPoints = Math.min(firstLayerData.points.length, secondLayerData.points.length, 1000);
        
        // Resample both layers to same point count
        const firstPoints = this.resamplePoints(firstLayerData.points, numPoints);
        const secondPoints = this.resamplePoints(secondLayerData.points, numPoints);
        
        const totalLayers = layerIndices.length;
        
        for (let i = 0; i < totalLayers; i++) {
            const layerIndex = layerIndices[i];
            const t = (i + 1) / (totalLayers + 1); // Interpolation factor
            const smoothT = this.blendstep(t, this.smoothFactor);
            
            const interpolatedPoints = this.interpolatePoints(firstPoints, secondPoints, smoothT);
            
            results.push({
                layerIndex: layerIndex,
                points: interpolatedPoints,
                closed: true
            });
        }
        
        const endTime = performance.now();
        console.log(`[INTERPOLATION] Pi completed ${layerIndices.length} layers in ${(endTime - startTime).toFixed(2)}ms`);
        
        return results;
    }

    resamplePoints(points, targetCount) {
        if (!points || points.length === 0) return [];
        if (points.length <= targetCount) return [...points];
        
        const result = [];
        const step = (points.length - 1) / (targetCount - 1);
        
        for (let i = 0; i < targetCount; i++) {
            const index = i * step;
            const lowerIndex = Math.floor(index);
            const upperIndex = Math.ceil(index);
            
            if (lowerIndex === upperIndex) {
                result.push({ ...points[lowerIndex] });
            } else {
                const alpha = index - lowerIndex;
                const lower = points[lowerIndex];
                const upper = points[upperIndex];
                
                result.push({
                    x: lower.x + (upper.x - lower.x) * alpha,
                    y: lower.y + (upper.y - lower.y) * alpha
                });
            }
        }
        
        return result;
    }

    interpolatePoints(pointsA, pointsB, t) {
        return pointsA.map((ptA, i) => {
            const ptB = pointsB[i] || ptA; // Fallback if arrays have different lengths
            return {
                x: (1 - t) * ptA.x + t * ptB.x,
                y: (1 - t) * ptA.y + t * ptB.y
            };
        });
    }

    blendstep(t, factor = 1) {
        const smooth = t * t * (3 - 2 * t); // classic smoothstep
        return (1 - factor) * t + factor * smooth;
    }
}

module.exports = InterpolationService;