import { remove3DLayer } from './threeD-model.js'
import * as CONSTS from './consts.js';

export class LayerItem {
  constructor(i) {
    this.layer = null; // The Paper.js layer
    this.name = `Layer ${i + 1}`;
    this.user_made = false; // Flag to indicate if the layer was created by the user
    this.actually_user_created = false; // Flag to track if layer was actually created by user (not auto-set)
    this.printed = false; // Flag to indicate if the layer has been printed
    this._mesh = null; // three.js mesh representation of this layer (private)
  }

  getLayer() {
    return this.layer;
  }

  // Mesh getter. (A duplicate `mesh(newMesh)` METHOD used to shadow this accessor pair
  // on the prototype, so `li.mesh` returned the function itself for undrawn layers —
  // truthy garbage that inflated mesh counts. Nothing ever called `.mesh()` as a
  // function, so the shim was removed and the accessors are live again.)
  get mesh() {
    return this._mesh;
  }

  // Mesh setter with automatic cleanup
  set mesh(newMesh) {
    // Remove existing mesh if it exists (and it isn't the very mesh being assigned)
    if (this._mesh && this._mesh !== newMesh) {
      remove3DLayer(this._mesh);
    }
    // Set the new mesh
    this._mesh = newMesh;
  }

  // Method to remove 3D layer (for compatibility with threeD-model.js)
  remove3DLayer() {
    if (this._mesh) {
      remove3DLayer(this._mesh);
      this._mesh = null;
    }
  }

  isUserMade() {
    return this.user_made;
  }

  removeAnchorPoints() {
    const lastChild = this.layer.lastChild;
    if (lastChild === null) {
      return;
    }

    if (lastChild.name === 'anchor-points') {
      lastChild.removeChildren();
    }
  }

  get anchorPoints() {
    // Search through all children to find the anchor-points group
    if (this.layer && this.layer.children) {
      for (let child of this.layer.children) {
        if (child.name === 'anchor-points') {
          return child;
        }
      }
    }

    // If no anchor-points group exists, create a new one
    const newGroup = new Group();
    newGroup.name = 'anchor-points';
    this.layer.addChild(newGroup);
    return newGroup;
  }

  setUserMade(userMade) {
    this.user_made = userMade;
    // When explicitly setting user_made to true, also mark as actually user created
    // When setting to false (reset), also clear actually_user_created
    if (userMade) {
      this.actually_user_created = true;
    } else {
      this.actually_user_created = false;
    }
  }

  isPrinted() {
    return this.printed;
  }

  setPrinted(printed) {
    this.printed = printed;
    
    // When a layer is marked as printed, also mark it as user-made
    // This ensures interpolation treats printed layers as immutable
    if (printed) {
      this.user_made = true;
    }

    // Don't modify the shared material color directly - this affects all layers
    // The material switching should be handled by the 3D model system's lockLayer function
    // which properly assigns the correct shared material to this specific mesh
  }

  setLocked(locked) {
    // Set both printed and locked state
    this.setPrinted(locked);
    this.locked = locked;
    
    console.log(`Layer ${this.name} ${locked ? 'locked' : 'unlocked'}`);
  }

  isLocked() {
    return this.locked || false;
  }

  clear() {
    if (this.layer !== null) {
      this.layer.removeChildren();
      this.layer = null; // Clear the layer reference
    }

    if (this._mesh) {
      remove3DLayer(this._mesh);
      this._mesh = null; // Clear the mesh reference
    }
  }

  setLayer(newLayer) {
    if (this.layer !== null) {
      this.layer.removeChildren();
    }
    this.addPath(newLayer.firstChild, true);
    this.layer.name = this.name;
  }

  addPath(path, userMade) {
    if (this.layer === null) {
      this.layer = new Layer();
    }

    this.layer.name = this.name;
    this.layer.addChild(path);
    this.setUserMade(userMade);
  }

  pointsAlongPath(amount) {
    if (!this.layer || !this.layer.firstChild) {
      return [];
    }

    const path = this.layer.firstChild;
    const arr = [];

    if (!path.length || path.length === 0) {
      return [];
    }

    const step = path.length / amount;
    for (let offset = 0; offset < path.length; offset += step) {
      const point = path.getPointAt(offset);
      if (point) {
        arr.push(point);
      }
    }
    return arr;
  }

}

