import * as CONSTS from './consts.js';
import { splineEditorScope, layers } from './utils.js';

let currentSplineView = 'Front';
const splineGridDistFromTopFactor = 0.05;

export function initializeSplineEditor() {
    splineEditorScope.activate(); // Activate the SplineEditor project
    
    // Draw the bed size line
    const view = splineEditorScope.view;
    const widthMidPoint = view.viewSize.width / 2;
    const canvasHeight = view.viewSize.height;
    const scaleFactor = CONSTS.SCALE_FACTOR * 0.2;
    const bedLength = [
        [widthMidPoint - (CONSTS.BED_SIZE / scaleFactor), canvasHeight - (canvasHeight * splineGridDistFromTopFactor) + 2],
        [widthMidPoint + (CONSTS.BED_SIZE / scaleFactor), canvasHeight - (canvasHeight * splineGridDistFromTopFactor) + 2]
    ];
    const bedLayer = new splineEditorScope.Layer({
        name: 'BedLayer',
    });
    const bedLine = new splineEditorScope.Path.Line({
        from: bedLength[0],
        to: bedLength[1],
        strokeColor: 'grey',
        strokeWidth: 5,
        name: 'BedLine',
    });
    bedLayer.addChild(bedLine);

    // Used to create another layer to be the active layer for splines
    const splinesLayer = new splineEditorScope.Layer({
        name: 'SplinesLayer',
    });

    initializeGuidingSplines('Front');
    initializeGuidingSplines('Right');
}

function initializeGuidingSplines(perspective) {

    // Create the left and right splines
    const leftSpline = new splineEditorScope.Path({
        strokeColor: 'blue',
        strokeWidth: 3,
        name: `${perspective}LeftSpline`,
    });

    const rightSpline = new splineEditorScope.Path({
        strokeColor: 'red',
        strokeWidth: 3,
        name: `${perspective}RightSpline`,
    });

    splineEditorScope.project.activeLayer.addChild(leftSpline);
    splineEditorScope.project.activeLayer.addChild(rightSpline);

}

export function switchView() {
    const view = splineEditorScope.project.view;
    currentSplineView = currentSplineView === 'Front' ? 'Right' : 'Front';
    splineEditorScope.project.activeLayer.clear();
    initializeGuidingSplines(currentSplineView, view);
    updateGuidingSplinesAll();
}

export function updateGuidingSplinesAll() {
    const leftSpline = splineEditorScope.project.getItem({ name: `${currentSplineView}LeftSpline` });
    const rightSpline = splineEditorScope.project.getItem({ name: `${currentSplineView}RightSpline` });

    // Clear existing segments
    leftSpline.removeSegments();
    rightSpline.removeSegments();

    layers.forEach((layer, index) => {
        if (layer.getLayer().isEmpty()) return;
        updateGuidingSplinesForLayer(layer, index, leftSpline, rightSpline);
});
}

export function updateGuidingSplinesForLayer(layer, index, left, right) {
    const view = splineEditorScope.view;
    const canvasHeight = view.viewSize.height;

    const curveLayer = layer.getLayer();

    // Find the topmost and bottommost points of the curve
    let topMost = Infinity;
    let bottomMost = -Infinity;

    // Check if a path already exists for the layer index
    const existingPath = splineEditorScope.project.getItem({ name: `Layer ${index + 1}` });
    if (existingPath) {
        existingPath.remove(); // Remove the old path
    }

    curveLayer.children.forEach((curve) => {
        curve.segments.forEach((segment) => {
            const point = currentSplineView === 'Front' ? segment.point.y : segment.point.x;
            if (point < topMost) topMost = point; // Update topmost point
            if (point > bottomMost) bottomMost = point; // Update bottommost point
        });
    });
    console.log(scaleFactor, 'scaleFactor');
    // Create left and right points based on topmost and bottommost points
    const leftPoint = new splineEditorScope.Point(
        topMost * scaleFactor, 
        canvasHeight - (canvasHeight * splineGridDistFromTopFactor) - (index * 3)
    );
    const rightPoint = new splineEditorScope.Point(
        bottomMost * scaleFactor, 
        canvasHeight - (canvasHeight * splineGridDistFromTopFactor) - (index * 3)
    );

    const repLine = new splineEditorScope.Path.Line({
        from: leftPoint,
        to: rightPoint,
        name: `Layer ${index + 1}`,
    });
    
    repLine.fullySelected = layer.isUserMade();
    
    if (layer.isUserMade()) {
        console.log(index, 'userMade: ', layer.isUserMade());
        repLine.strokeColor = 'black';
        repLine.strokeWidth = 2;
    } else {
        repLine.strokeColor = 'blue';
        repLine.strokeWidth = 1;
    }

    left.add(leftPoint);
    right.add(rightPoint);

    splineEditorScope.project.activeLayer.addChild(repLine);
};

export function splineHandleOnMouseDown(event) {
    const hitResult = splineEditorScope.project.hitTest(event.point);
    if (hitResult && hitResult.segment) {
        console.log("Control point clicked:", hitResult.segment.point);
    }
};

export function splineHandleOnMouseDrag(event) {
    const hitResult = splineEditorScope.project.hitTest(event.point);
    if (hitResult && hitResult.segment) {
        hitResult.segment.point = event.point; // Update the segment's position
    }
    splineEditorScope.view.update();
};

export function splineHandleOnMouseUp(event) {
    splineEditorScope.view.update();
};

