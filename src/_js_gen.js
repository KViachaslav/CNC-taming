// ============================================================
// ГЛОБАЛЬНЫЙ ПЕРЕХВАТ ОШИБОК
// ============================================================
window.addEventListener('error', (e) => {
    const el = document.getElementById('error-log');
    if (el) {
        el.style.display = 'block';
        el.innerText = 'JS Error: ' + (e.message || e.error) + '\n' + (e.filename || '') + ':' + (e.lineno || '');
    }
    console.error(e);
});

// ============================================================
// 0. CLIPPER-LIB
// ============================================================
const CLIPPER_SCALE = 1000;
const CLIPPER = window.ClipperLib;

// ============================================================
// 1. THREE.JS INIT
// ============================================================
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x121212);

// Вьюпорт живёт внутри рабочей области CNC Suite, а не на всё окно:
// размер берём по контейнеру (с откатом на окно, если он ещё не измерен).
function viewSize() {
    const w = (container && container.clientWidth) || window.innerWidth;
    const h = (container && container.clientHeight) || window.innerHeight;
    return { w: Math.max(1, w), h: Math.max(1, h) };
}
const _view0 = viewSize();

const camera = new THREE.PerspectiveCamera(45, _view0.w / _view0.h, 0.1, 5000);
camera.position.set(0, -100, 150);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(_view0.w, _view0.h);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
dirLight.position.set(50, -50, 100);
scene.add(dirLight);

const grid = new THREE.GridHelper(300, 30, 0x444444, 0x222222);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

const dxfGroup = new THREE.Group();
scene.add(dxfGroup);

const toolpathGroup = new THREE.Group();
toolpathGroup.name = 'toolpath';
scene.add(toolpathGroup);

const drillGroup = new THREE.Group();
drillGroup.name = 'drillpath';
scene.add(drillGroup);

const laserGroup = new THREE.Group();
laserGroup.name = 'laserpath';
scene.add(laserGroup);

let layerGroups = {};
let layerColors = {};

// ============================================================
// 2. DXF PARSER
// ============================================================
class DXFParser {
    constructor() { this.i = 0; this.lines = []; }

    readGroup() {
        if (this.i >= this.lines.length - 1) return null;
        const code = parseInt(this.lines[this.i].trim(), 10);
        const value = this.lines[this.i + 1].trim();
        this.i += 2;
        return { code, value };
    }

    parse(text) {
        this.lines = text.split(/\r\n|\r|\n/);
        this.i = 0;
        const layers = {};
        const entities = [];
        let currentSection = null;

        while (this.i < this.lines.length - 1) {
            const group = this.readGroup();
            if (!group) break;

            if (group.code === 0 && group.value === 'SECTION') {
                const secGroup = this.readGroup();
                if (secGroup && secGroup.code === 2) currentSection = secGroup.value;
            } else if (group.code === 0 && group.value === 'ENDSEC') {
                currentSection = null;
            } else if (currentSection === 'TABLES') {
                if (group.code === 0 && group.value === 'LAYER') this.parseLayer(layers);
            } else if (currentSection === 'ENTITIES') {
                if (group.code === 0) {
                    const t = group.value;
                    if (['LWPOLYLINE', 'LINE', 'HATCH', 'CIRCLE', 'ARC'].includes(t)) {
                        const e = this.parseEntity(t);
                        if (e) entities.push(e);
                    }
                }
            }
        }
        console.log('[DXF] parsed layers:', Object.keys(layers).length, 'entities:', entities.length);
        return { layers, entities };
    }

    parseLayer(layers) {
        let name = '', colorHex = 0xffffff;
        while (true) {
            const g = this.readGroup();
            if (!g || g.code === 0) { if (g) this.i -= 2; break; }
            if (g.code === 2) name = g.value;
            if (g.code === 62) colorHex = this.dxfColorToHex(parseInt(g.value, 10));
            if (g.code === 420) colorHex = parseInt(g.value, 10);
        }
        if (name) layers[name] = { color: colorHex };
    }

    parseEntity(type) {
        const e = { type, layer: '0', width: 0, points: [], loops: [], isClosed: false };
        let curPoint = null, curLoop = null;

        let hatchVertexCount = 0;
        let hatchVertexIndex = 0;
        let inPolylineBoundary = false;

        while (true) {
            const g = this.readGroup();
            if (!g || g.code === 0) { if (g) this.i -= 2; break; }

            if (g.code === 8) e.layer = g.value;
            if (g.code === 43) e.width = parseFloat(g.value);
            if (g.code === 70) e.isClosed = (parseInt(g.value, 10) & 1) === 1;

            if (type === 'LWPOLYLINE') {
                if (g.code === 10) { curPoint = { x: parseFloat(g.value), y: null, bulge: 0 }; e.points.push(curPoint); }
                else if (g.code === 20 && curPoint) curPoint.y = parseFloat(g.value);
                else if (g.code === 42 && curPoint) curPoint.bulge = parseFloat(g.value);
            } else if (type === 'CIRCLE') {
                if (g.code === 10) e.cx = parseFloat(g.value);
                if (g.code === 20) e.cy = parseFloat(g.value);
                if (g.code === 40) e.r  = parseFloat(g.value);
            } else if (type === 'ARC') {
                if (g.code === 10) e.cx = parseFloat(g.value);
                if (g.code === 20) e.cy = parseFloat(g.value);
                if (g.code === 40) e.r  = parseFloat(g.value);
                if (g.code === 50) e.startAngle = parseFloat(g.value);
                if (g.code === 51) e.endAngle = parseFloat(g.value);
            } else if (type === 'HATCH') {
                if (g.code === 92) {
                    if (curLoop && curLoop.length > 0) e.loops.push(curLoop);
                    curLoop = [];
                    hatchVertexCount = 0;
                    hatchVertexIndex = 0;
                    inPolylineBoundary = false;
                } else if (g.code === 73) {
                    inPolylineBoundary = (parseInt(g.value, 10) === 1);
                } else if (g.code === 93) {
                    hatchVertexCount = parseInt(g.value, 10);
                    hatchVertexIndex = 0;
                } else if (g.code === 10 && curLoop && inPolylineBoundary) {
                    if (hatchVertexCount === 0 || hatchVertexIndex < hatchVertexCount) {
                        curPoint = { x: parseFloat(g.value), y: null, bulge: 0 };
                        curLoop.push(curPoint);
                    }
                } else if (g.code === 20 && curPoint && inPolylineBoundary) {
                    if (hatchVertexCount === 0 || hatchVertexIndex < hatchVertexCount) {
                        curPoint.y = parseFloat(g.value);
                        hatchVertexIndex++;
                    }
                } else if (g.code === 42 && curPoint && inPolylineBoundary) {
                    curPoint.bulge = parseFloat(g.value);
                }
            } else if (type === 'LINE') {
                if (g.code === 10) e.p1 = { x: parseFloat(g.value), y: 0 };
                if (g.code === 20 && e.p1) e.p1.y = parseFloat(g.value);
                if (g.code === 11) e.p2 = { x: parseFloat(g.value), y: 0 };
                if (g.code === 21 && e.p2) e.p2.y = parseFloat(g.value);
            }
        }

        if (type === 'HATCH' && curLoop && curLoop.length > 0) {
            e.loops.push(curLoop);
        }

        if (e.points.length > 0) {
            e.points = e.points.filter(p => p.x !== null && p.y !== null && !isNaN(p.x) && !isNaN(p.y));
        }
        if (e.loops.length > 0) {
            e.loops = e.loops
                .map(l => l.filter(p => p.x !== null && p.y !== null && !isNaN(p.x) && !isNaN(p.y)))
                .filter(l => l.length > 0);
        }
        return e;
    }

    dxfColorToHex(idx) {
        const c = [0x000000,0xff0000,0xffff00,0x00ff00,0x00ffff,0x0000ff,0xff00ff,0xffffff,0x808080,0xc0c0c0];
        return c[Math.abs(idx) % c.length] || 0xcccccc;
    }
}

// ============================================================
// 3. BUILD DXF SCENE
// ============================================================
function getPolygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(a / 2);
}

function arcToPoints(cx, cy, r, startAngle, endAngle, segments) {
    const points = [];
    let sa = startAngle * Math.PI / 180;
    let ea = endAngle * Math.PI / 180;
    while (ea < sa) ea += 2 * Math.PI;
    const step = (ea - sa) / segments;
    for (let i = 0; i <= segments; i++) {
        const a = sa + step * i;
        points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return points;
}

function bulgeToPoints(loop, maxSegLen = 0.5) {
    const result = [];
    const n = loop.length;
    if (n < 2) return loop.map(p => ({ x: p.x, y: p.y }));

    for (let i = 0; i < n; i++) {
        const p1 = loop[i];
        const p2 = loop[(i + 1) % n];
        result.push({ x: p1.x, y: p1.y });

        const bulge = p1.bulge || 0;
        if (Math.abs(bulge) < 1e-9) continue;

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const chord = Math.hypot(dx, dy);
        if (chord < 1e-12) continue;

        const theta = 4 * Math.atan(bulge);
        const sinHalf = Math.sin(theta / 2);
        const radius = chord / (2 * sinHalf);
        const rAbs = Math.abs(radius);

        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const px = -dy / chord;
        const py =  dx / chord;
        const h = radius * Math.cos(theta / 2);
        const cx = mx + px * h;
        const cy = my + py * h;

        const a1 = Math.atan2(p1.y - cy, p1.x - cx);
        const a2 = Math.atan2(p2.y - cy, p2.x - cx);

        let da = a2 - a1;
        if (theta > 0) { while (da <= 0) da += 2 * Math.PI; }
        else           { while (da >= 0) da -= 2 * Math.PI; }

        const arcLen = rAbs * Math.abs(da);
        const steps = Math.max(2, Math.ceil(arcLen / maxSegLen));

        for (let s = 1; s < steps; s++) {
            const a = a1 + da * (s / steps);
            result.push({ x: cx + rAbs * Math.cos(a), y: cy + rAbs * Math.sin(a) });
        }
    }
    return result;
}

// Круг (2 точки с bulge ≈ ±1) НА СЛОЕ ГРАНИЦЫ — это контур платы или
// внутреннего отверстия, а не площадка. Залитый диск тут недопустим: диск
// радиуса платы накрывает всю медь (дорожки исчезают), а диск отверстия
// сливается с ним в «один залитый круг». Рисуем кольцо по толщине полилинии.
// (OUTLINE_LAYER_RE объявлен ниже — используется уже во время вызова.)
function addOutlineRing(layerName, cx, cy, r, width, mat) {
    const w = (width > 0 ? width : 0.2);
    const inner = Math.max(0.001, r - w / 2);
    const outer = Math.max(inner + 0.001, r + w / 2);
    const seg = Math.max(24, Math.min(256, Math.round(r * 8)));
    const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, seg), mat);
    m.position.set(cx, cy, 0);
    layerGroups[layerName].add(m);
    return m;
}

function build3DScene(parsed) {
    while (dxfGroup.children.length) dxfGroup.remove(dxfGroup.children[0]);
    layerGroups = {}; layerColors = {};

    const listEl = document.getElementById('layers-list');
    listEl.innerHTML = '';

    parsed.entities.forEach(ent => {
        const layerName = ent.layer || '0';
        if (!layerGroups[layerName]) {
            layerGroups[layerName] = new THREE.Group();
            layerGroups[layerName].name = layerName;
            const color = (parsed.layers[layerName] && parsed.layers[layerName].color)
                ? parsed.layers[layerName].color : 0x00aaff;
            layerColors[layerName] = color;
            dxfGroup.add(layerGroups[layerName]);
        }
        const color = layerColors[layerName];
        const isMultiLayer = /multi[\s_-]?layer|^mu$|multilayer/i.test(layerName);
        const isTopLayer   = /top|верх|silk|outline|edge[\s_-]?cuts|board[\s_-]?outline|контур|границ/i.test(layerName);
        const isBottomLayer= /bottom|низ/i.test(layerName);

        let polyOffsetFactor = 0;
        let polyOffsetUnits  = 0;
        if (isMultiLayer) { polyOffsetFactor = -2; polyOffsetUnits = -2; }
        else if (isTopLayer) { polyOffsetFactor = -1; polyOffsetUnits = -1; }
        else if (isBottomLayer) { polyOffsetFactor = 1; polyOffsetUnits = 1; }

        const mat = new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: polyOffsetFactor,
            polygonOffsetUnits:  polyOffsetUnits,
            depthWrite: !isMultiLayer,
            transparent: isMultiLayer,
            opacity: isMultiLayer ? 0.95 : 1.0
        });

        if (ent.type === 'LWPOLYLINE' && ent.points.length === 2) {
            const p1 = ent.points[0], p2 = ent.points[1];
            if (Math.abs(p1.bulge || 0) > 0.99 && Math.abs(p2.bulge || 0) > 0.99) {
                const cx = (p1.x + p2.x) / 2;
                const cy = (p1.y + p2.y) / 2;
                const r = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
                // На слое границы круг — контур платы/отверстия: рисуем кольцо,
                // иначе «круглая плата» превращается в залитый диск, который
                // закрывает медь и внутреннее круглое отверстие.
                if (r > 0 && OUTLINE_LAYER_RE.test(layerName)) {
                    addOutlineRing(layerName, cx, cy, r, ent.width, mat);
                    return;
                }
                const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), mat);
                m.position.set(cx, cy, 0);
                layerGroups[layerName].add(m);
                return;
            }
        }

        if (ent.type === 'LWPOLYLINE' && ent.points.length > 1) {
            const hasBulge = ent.points.some(p => Math.abs(p.bulge || 0) > 1e-6);
            const pts = hasBulge ? bulgeToPoints(ent.points) : [...ent.points];

            // Замкнутый контур без заданной толщины — это залитая область
            // (площадка / полигон меди). Рисуем её заливкой, а не "лентой" 0.2 мм,
            // иначе площадки визуально раздуваются и между ними не видно зазора.
            // Исключение — слой границы платы: там замкнутый контур это контур
            // (плата / вырез), заливка накрыла бы всю медь.
            if (ent.isClosed && ent.width <= 0 && !OUTLINE_LAYER_RE.test(layerName) && pts.length >= 3) {
                const clean = [];
                for (const p of pts) {
                    if (!clean.length ||
                        Math.hypot(p.x - clean[clean.length - 1].x, p.y - clean[clean.length - 1].y) > 1e-4) {
                        clean.push({ x: p.x, y: p.y });
                    }
                }
                if (clean.length >= 3) {
                    try {
                        const shape = new THREE.Shape();
                        shape.moveTo(clean[0].x, clean[0].y);
                        for (let k = 1; k < clean.length; k++) shape.lineTo(clean[k].x, clean[k].y);
                        shape.closePath();
                        layerGroups[layerName].add(new THREE.Mesh(new THREE.ShapeGeometry(shape), mat));
                    } catch (err) { console.error('filled polyline error', err); }
                    return;
                }
            }

            if (ent.isClosed && pts.length > 2) pts.push(pts[0]);
            const w = ent.width > 0 ? ent.width : 0.2;
            for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i], p2 = pts[i + 1];
                const dx = p2.x - p1.x, dy = p2.y - p1.y;
                const len = Math.hypot(dx, dy);
                if (len < 1e-4) continue;
                const nx = -dy / len * (w / 2), ny = dx / len * (w / 2);
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
                    p1.x + nx, p1.y + ny, 0, p1.x - nx, p1.y - ny, 0, p2.x + nx, p2.y + ny, 0,
                    p2.x + nx, p2.y + ny, 0, p1.x - nx, p1.y - ny, 0, p2.x - nx, p2.y - ny, 0,
                ]), 3));
                layerGroups[layerName].add(new THREE.Mesh(geom, mat));
                const cap = new THREE.Mesh(new THREE.CircleGeometry(w / 2, 12), mat);
                cap.position.set(p1.x, p1.y, 0);
                layerGroups[layerName].add(cap);
            }
        }

        if (ent.type === 'CIRCLE' && ent.r > 0 && !isNaN(ent.cx) && !isNaN(ent.cy)) {
            const m = new THREE.Mesh(new THREE.CircleGeometry(ent.r, 48), mat);
            m.position.set(ent.cx, ent.cy, 0);
            layerGroups[layerName].add(m);
        }

        if (ent.type === 'ARC' && ent.r > 0 && !isNaN(ent.cx) && !isNaN(ent.cy)) {
            const pts = arcToPoints(ent.cx, ent.cy, ent.r, ent.startAngle, ent.endAngle, 24);
            const w = ent.width > 0 ? ent.width : 0.2;
            for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i], p2 = pts[i + 1];
                const dx = p2.x - p1.x, dy = p2.y - p1.y;
                const len = Math.hypot(dx, dy);
                if (len < 1e-4) continue;
                const nx = -dy / len * (w / 2), ny = dx / len * (w / 2);
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
                    p1.x + nx, p1.y + ny, 0, p1.x - nx, p1.y - ny, 0, p2.x + nx, p2.y + ny, 0,
                    p2.x + nx, p2.y + ny, 0, p1.x - nx, p1.y - ny, 0, p2.x - nx, p2.y - ny, 0,
                ]), 3));
                layerGroups[layerName].add(new THREE.Mesh(geom, mat));
            }
        }

        if (ent.type === 'HATCH' && ent.loops.length > 0) {
            let drawnAsCircle = false;
            for (const loop of ent.loops) {
                if (loop.length === 2 &&
                    Math.abs(loop[0].bulge || 0) > 0.99 &&
                    Math.abs(loop[1].bulge || 0) > 0.99) {
                    const p1 = loop[0], p2 = loop[1];
                    const cx = (p1.x + p2.x) / 2;
                    const cy = (p1.y + p2.y) / 2;
                    const r = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
                    if (OUTLINE_LAYER_RE.test(layerName)) {
                        // контур платы/отверстия — кольцо, а не залитый диск
                        addOutlineRing(layerName, cx, cy, r, ent.width, mat);
                    } else {
                        const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), mat);
                        m.position.set(cx, cy, 0);
                        layerGroups[layerName].add(m);
                    }
                    drawnAsCircle = true;
                    break;
                }
            }
            if (drawnAsCircle) return;

            let validLoops = ent.loops
                .map(l => bulgeToPoints(l))
                .filter(l => l.length >= 3);

            if (validLoops.length > 0) {
                validLoops.sort((a, b) => getPolygonArea(b) - getPolygonArea(a));
                const outer = validLoops[0];
                const shape = new THREE.Shape();
                shape.moveTo(outer[0].x, outer[0].y);
                for (let k = 1; k < outer.length; k++) shape.lineTo(outer[k].x, outer[k].y);
                shape.closePath();
                for (let i = 1; i < validLoops.length; i++) {
                    const h = validLoops[i];
                    const path = new THREE.Path();
                    path.moveTo(h[0].x, h[0].y);
                    for (let k = 1; k < h.length; k++) path.lineTo(h[k].x, h[k].y);
                    path.closePath();
                    shape.holes.push(path);
                }
                try {
                    const geom = new THREE.ShapeGeometry(shape);
                    layerGroups[layerName].add(new THREE.Mesh(geom, mat));
                } catch (err) {
                    console.error('HATCH triangulate error', err);
                }
            }
        }
    });

    const isMulti   = n => /multi[\s_-]?layer|^mu$|multilayer/i.test(n);
    const isOutline = n => /board[\s_-]?outline|edge[\s_-]?cuts|outline|контур|границ/i.test(n);

    const autoSelected = [];
    const allLayers = Object.keys(layerGroups);

    allLayers.forEach(name => {
        const auto = isMulti(name) || isOutline(name);
        if (auto) autoSelected.push(name);

        const item = document.createElement('div');
        item.className = 'layer-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = auto;
        layerGroups[name].visible = auto;
        cb.addEventListener('change', e => { layerGroups[name].visible = e.target.checked; });

        const badge = document.createElement('span');
        badge.className = 'layer-color-badge';
        badge.style.backgroundColor = '#' + layerColors[name].toString(16).padStart(6, '0');

        const lbl = document.createElement('span');
        lbl.innerText = name;

        item.append(cb, badge, lbl);
        listEl.appendChild(item);
    });

    if (autoSelected.length === 0) {
        allLayers.forEach(n => layerGroups[n].visible = true);
        listEl.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = true);
    }

    document.getElementById('layers-count').innerText = '(' + allLayers.length + ')';

    try {
        dxfGroup.updateMatrixWorld(true);
        const vBox = new THREE.Box3();
        Object.values(layerGroups).forEach(g => {
            if (g.visible) {
                try { vBox.expandByObject(g); } catch (err) { /* skip */ }
            }
        });
        if (vBox.isEmpty()) vBox.setFromObject(dxfGroup);

        if (!vBox.isEmpty()) {
            const center = vBox.getCenter(new THREE.Vector3());
            const size   = vBox.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z) || 100;
            controls.target.copy(center);
            camera.position.set(center.x, center.y - maxDim * 1.2, maxDim * 1.2);
            camera.lookAt(center);
            controls.update();
            grid.position.set(center.x, center.y, -0.1);
        }
    } catch (err) {
        console.error('BBox error:', err);
    }

    document.getElementById('stats').innerText =
        `Слоев: ${allLayers.length} | Объектов: ${parsed.entities.length}`;
}

// ============================================================
// 4. ИЗВЛЕЧЕНИЕ ПОЛИГОНОВ (фрезеровка)
// ============================================================
// Контуры строятся НАПРЯМУЮ из DXF-геометрии, а не из треугольного меша.
// Это устраняет сразу несколько проблем:
//   * корректный обход НЕВЫПУКЛЫХ полигонов (порядок вершин сохраняется,
//     центр-сортировка по углу не применяется);
//   * нет "раздувания" площадок шириной линии по умолчанию (width = 0
//     у замкнутого контура = залитая область, а не обводка 0.2 мм);
//   * корректный учёт внутренних отверстий (HATCH с несколькими петлями).
const OUTLINE_LAYER_RE = /board[\s_-]?outline|edge[\s_-]?cuts|outline|контур|границ/i;

// Промежуточные точки дуги (bulge) между p1 и p2 (без самих концов)
function arcBetween(p1, p2, bulge, maxSegLen) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-12 || Math.abs(bulge) < 1e-12) return [];
    const theta = 4 * Math.atan(bulge);
    const sinHalf = Math.sin(theta / 2);
    if (Math.abs(sinHalf) < 1e-12) return [];
    const radius = chord / (2 * sinHalf);
    const rAbs = Math.abs(radius);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const px = -dy / chord, py = dx / chord;
    const h = radius * Math.cos(theta / 2);
    const cx = mx + px * h, cy = my + py * h;
    const a1 = Math.atan2(p1.y - cy, p1.x - cx);
    const a2 = Math.atan2(p2.y - cy, p2.x - cx);
    let da = a2 - a1;
    if (theta > 0) { while (da <= 0) da += Math.PI * 2; }
    else { while (da >= 0) da -= Math.PI * 2; }
    const steps = Math.max(2, Math.ceil((rAbs * Math.abs(da)) / (maxSegLen || 0.5)));
    const out = [];
    for (let s = 1; s < steps; s++) {
        const a = a1 + da * (s / steps);
        out.push({ x: cx + rAbs * Math.cos(a), y: cy + rAbs * Math.sin(a) });
    }
    return out;
}

// Разворачиваем полилинию (с bulge) в упорядоченный список точек
function expandPolyline(points, closed, maxSegLen = 0.5) {
    const res = [];
    const n = points.length;
    if (n === 0) return res;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
        const p1 = points[i], p2 = points[(i + 1) % n];
        res.push({ x: p1.x, y: p1.y });
        if (Math.abs(p1.bulge || 0) > 1e-9) res.push(...arcBetween(p1, p2, p1.bulge, maxSegLen));
    }
    if (!closed) res.push({ x: points[n - 1].x, y: points[n - 1].y });
    return res;
}

function circleToPolygon(cx, cy, r, segments = 48) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
}

// Убираем совпадающие подряд вершины; у замкнутого контура — дубль первой
function cleanLoop(points, closed, eps = 1e-4) {
    const out = [];
    for (const p of points) {
        if (!out.length ||
            Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > eps) {
            out.push({ x: p.x, y: p.y });
        }
    }
    if (closed && out.length > 1 &&
        Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) {
        out.pop();
    }
    return out;
}

function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return a / 2;
}

// --- Ориентация контуров ---------------------------------------------------
// Обход петель в DXF произволен: EasyEDA/Altium экспортируют площадки по
// часовой (signedArea < 0), а HATCH-заливки встречаются в обоих направлениях.
// Полигоны, которые строит Clipper (буферы обводок в bufferPaths, результат
// разности в differencePaths), приходят с ориентацией наоборот. Union идёт по
// правилу NonZero и «складывает» обходы, поэтому площадка (−1) с наложенным на
// неё буфером дорожки (+1) давала нулевое вращение — в центре площадки, под
// концом дорожки, вырубалась фальшивая дырка диаметром с дорожку. Фреза потом
// обводила кольцо в этой дырке, а лазер те же контуры заливал.
// Поэтому любую «просто медь» (заливки, буферы обводок) приводим к одной
// ориентации: внешний контур — против часовой (положительная площадь).
function asPositiveLoop(pts) {
    return (pts.length >= 3 && signedArea(pts) < 0) ? pts.slice().reverse() : pts;
}

function asNegativeLoop(pts) {
    return (pts.length >= 3 && signedArea(pts) > 0) ? pts.slice().reverse() : pts;
}

// Группа контуров одной фигуры (внешний контур + отверстия). Выравниваем по
// самому большому контуру: если он идёт по часовой, разворачиваем всю группу —
// взаимная ориентация (отверстия встречные) сохраняется, а сам контур
// становится положительным. Иначе NonZero-union зальёт кольцо (потеряем
// настоящее отверстие) либо, наоборот, вырежет дырку в меди.
function orientLoopGroup(paths) {
    if (!paths || !paths.length) return paths;
    let idx = 0, best = -1;
    paths.forEach((p, i) => {
        if (!p || p.length < 3) return;
        const a = Math.abs(signedArea(p));
        if (a > best) { best = a; idx = i; }
    });
    if (!paths[idx] || paths[idx].length < 3) return paths;
    if (signedArea(paths[idx]) >= 0) return paths;
    return paths.map(p => p.slice().reverse());
}

// --- Отсев «мусора» --------------------------------------------------------
// Целочисленный оффсет Clipper на касающихся/вырожденных фигурах оставляет
// контуры в десятки микрометров: резать там нечего, но в G-code они попадают
// как лишние врезания и обводы. Пороги — в миллиметрах.
const MIN_CUT_DIAG_MM = 0.05;    // габарит контура
const MIN_CUT_AREA_MM2 = 0.002;  // площадь (≈ кружок ⌀0.05 мм)
// Габарит контура (диагональ bbox) в тех же единицах, что и точки.
function contourDiag(pts) {
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const p of pts) {
        if (p.x < xMin) xMin = p.x;
        if (p.y < yMin) yMin = p.y;
        if (p.x > xMax) xMax = p.x;
        if (p.y > yMax) yMax = p.y;
    }
    if (xMin > xMax || yMin > yMax) return 0;
    return Math.hypot(xMax - xMin, yMax - yMin);
}
function isDegenerateContour(pts) {
    if (!pts || pts.length < 3) return true;
    if (contourDiag(pts) < MIN_CUT_DIAG_MM) return true;
    return Math.abs(signedArea(pts)) < MIN_CUT_AREA_MM2;
}

function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        if (((yi > pt.y) !== (yj > pt.y)) &&
            (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}
// Обводка открытых/замкнутых линий (дорожки, дуги) в полигоны
function bufferPaths(strokes) {
    if (!CLIPPER || strokes.length === 0) return [];
    const result = [];
    strokes.forEach(s => {
        if (!s.pts || s.pts.length < 2) return;
        let pts = s.pts.map(p => ({ x: p.x, y: p.y }));
        if (s.closed && (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y)) {
            pts = pts.concat([pts[0]]);
        }
        const delta = Math.max(1, Math.round((s.width / 2) * CLIPPER_SCALE));
        const off = new CLIPPER.ClipperOffset(2.0, 0.25);
        off.AddPath(pts.map(toClipperPoint), CLIPPER.JoinType.jtRound,
            s.closed ? CLIPPER.EndType.etClosedLine : CLIPPER.EndType.etOpenRound);
        const sol = new CLIPPER.Paths();
        off.Execute(sol, delta);
        // У замкнутой линии оффсет даёт два контура (кольцо): внешний делаем
        // положительным, внутренний оставляем встречным — иначе NonZero-union
        // зальёт кольцо (или, наоборот, вырежет дырку в меди).
        orientLoopGroup(sol.map(p => p.map(fromClipperPoint)))
            .forEach(p => result.push(p));
    });
    return result;
}

// Внешний контур минус отверстия (для HATCH с несколькими петлями)
function differencePaths(outer, holes) {
    const result = [];
    const inner = holes.filter(h => pointInPolygon(h[0], outer));
    const separate = holes.filter(h => !pointInPolygon(h[0], outer));

    if (inner.length) {
        const c = new CLIPPER.Clipper();
        // вход приводим к канонической ориентации: внешний — положительный,
        // отверстия — встречные (у сырых петель DXF обход произвольный)
        c.AddPath(asPositiveLoop(outer).map(toClipperPoint), CLIPPER.PolyType.ptSubject, true);
        inner.forEach(h => c.AddPath(asNegativeLoop(h).map(toClipperPoint), CLIPPER.PolyType.ptClip, true));
        const sol = new CLIPPER.Paths();
        c.Execute(CLIPPER.ClipType.ctDifference, sol,
            CLIPPER.PolyFillType.pftNonZero, CLIPPER.PolyFillType.pftNonZero);
        orientLoopGroup(sol.map(p => p.map(fromClipperPoint)))
            .forEach(p => result.push(p));
    } else {
        result.push(asPositiveLoop(outer).map(p => ({ x: p.x, y: p.y })));
    }
    // разрозненные острова — обычная медь
    separate.forEach(h => result.push(asPositiveLoop(h).map(p => ({ x: p.x, y: p.y }))));
    return result;
}
// Собираем все полигоны для фрезеровки из распарсенного DXF.
//   * замкнутый контур с толщиной 0  -> залитая область (площадка/полигон);
//   * замкнутый контур с толщиной >0 -> обводка по средней линии;
//   * открытая линия с толщиной 0    -> обводка шириной defaultLineWidth;
//   * HATCH -> заливка (с учётом отверстий);
//   * CIRCLE -> заливка; ARC/LINE -> обводка.
function collectMillingPolygons(parsed, isVisible, defaultLineWidth) {
    const fills = [];       // простые замкнутые полигоны (области меди)
    const hatchGroups = []; // петли HATCH (внешний контур + отверстия)
    const strokes = [];     // { pts, width, closed }

    parsed.entities.forEach(ent => {
        const layer = ent.layer || '0';
        if (!isVisible(layer)) return;

        if (ent.type === 'HATCH') {
            if (!ent.loops || !ent.loops.length) return;
            const loops = ent.loops
                .map(l => cleanLoop(expandPolyline(l, true), true))
                .filter(l => l.length >= 3);
            if (!loops.length) return;
            // заливка = медь: обход всегда против часовой (см. asPositiveLoop)
            if (loops.length === 1) fills.push(asPositiveLoop(loops[0]));
            else hatchGroups.push(loops);
            return;
        }

        if (ent.type === 'CIRCLE') {
            if (ent.r > 0 && isFinite(ent.cx) && isFinite(ent.cy)) {
                fills.push(asPositiveLoop(circleToPolygon(ent.cx, ent.cy, ent.r, 48)));
            }
            return;
        }

        if (ent.type === 'ARC') {
            if (ent.r > 0 && isFinite(ent.cx) && isFinite(ent.cy)) {
                const pts = arcToPoints(ent.cx, ent.cy, ent.r, ent.startAngle, ent.endAngle, 24);
                strokes.push({ pts, width: ent.width > 0 ? ent.width : defaultLineWidth, closed: false });
            }
            return;
        }

        if (ent.type === 'LINE') {
            if (ent.p1 && ent.p2) {
                strokes.push({ pts: [ent.p1, ent.p2], width: ent.width > 0 ? ent.width : defaultLineWidth, closed: false });
            }
            return;
        }

        if (ent.type === 'LWPOLYLINE' && ent.points.length > 1) {
            // 2 точки с bulge ~1 => окружность (как в отрисовке)
            if (ent.points.length === 2) {
                const p1 = ent.points[0], p2 = ent.points[1];
                if (Math.abs(p1.bulge || 0) > 0.99 && Math.abs(p2.bulge || 0) > 0.99) {
                    const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
                    const r = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
                    if (r > 0) {
                        if (OUTLINE_LAYER_RE.test(layer)) {
                            // Круг на слое границы (круглая плата / круглое отверстие) —
                            // это контур, а не медь. Иначе весь диск платы становится
                            // «медью»: внутреннее отверстие исчезает, а фреза обходит
                            // плату снаружи (путь уходит за габарит).
                            strokes.push({ pts: circleToPolygon(cx, cy, r, 48),
                                           width: ent.width > 0 ? ent.width : defaultLineWidth,
                                           closed: true });
                        } else {
                            fills.push(asPositiveLoop(circleToPolygon(cx, cy, r, 48)));
                        }
                    }
                    return;
                }
            }

            const n = ent.points.length;
            const closed = ent.isClosed ||
                (n > 2 && Math.hypot(ent.points[0].x - ent.points[n - 1].x,
                                     ent.points[0].y - ent.points[n - 1].y) < 1e-4);
            const pts = cleanLoop(expandPolyline(ent.points, closed), closed);
            if (pts.length < 2) return;

            if (ent.width > 0) {
                strokes.push({ pts, width: ent.width, closed });
            } else if (closed) {
                if (OUTLINE_LAYER_RE.test(layer)) {
                    // контур платы без толщины — тонкая линия, а не заливка
                    strokes.push({ pts, width: defaultLineWidth, closed: true });
                } else {
                    // замкнутый контур без толщины = залитая область (площадка/полигон)
                    fills.push(asPositiveLoop(pts));
                }
            } else {
                strokes.push({ pts, width: defaultLineWidth, closed: false });
            }
        }
    });

    const polys = fills.slice();

    // HATCH с несколькими петлями: внешний контур минус внутренние
    hatchGroups.forEach(loops => {
        const withArea = loops.map(l => ({ l, a: Math.abs(signedArea(l)) }))
                              .sort((x, y) => y.a - x.a);
        const outer = withArea[0].l;
        const holes = withArea.slice(1).map(w => w.l);
        differencePaths(outer, holes).forEach(p => polys.push(p));
    });

    // Обводки (дорожки/дуги/контуры) -> буфер по половине толщины
    bufferPaths(strokes).forEach(p => polys.push(p));

    return polys;
}

// ============================================================
// 5. CLIPPER
// ============================================================
function toClipperPoint(p) {
    return { X: Math.round(p.x * CLIPPER_SCALE), Y: Math.round(p.y * CLIPPER_SCALE) };
}
function fromClipperPoint(p) {
    return { x: p.X / CLIPPER_SCALE, y: p.Y / CLIPPER_SCALE };
}

function clipperUnion(polygons) {
    if (!CLIPPER || polygons.length === 0) return [];
    const subjPaths = polygons.map(poly => poly.map(toClipperPoint));
    const clipper = new CLIPPER.Clipper();
    clipper.AddPaths(subjPaths, CLIPPER.PolyType.ptSubject, true);
    const solution = new CLIPPER.Paths();
    clipper.Execute(CLIPPER.ClipType.ctUnion, solution,
                    CLIPPER.PolyFillType.pftNonZero, CLIPPER.PolyFillType.pftNonZero);
    const simplified = CLIPPER.Clipper.SimplifyPolygons(solution, CLIPPER.PolyFillType.pftNonZero);
    return simplified.map(path => path.map(fromClipperPoint));
}

function clipperOffset(polygons, deltaMm) {
    if (!CLIPPER || polygons.length === 0) return [];
    const deltaInt = Math.round(deltaMm * CLIPPER_SCALE);
    const offset = new CLIPPER.ClipperOffset(2.0, 0.25);
    offset.AddPaths(
        polygons.map(poly => poly.map(toClipperPoint)),
        CLIPPER.JoinType.jtRound,
        CLIPPER.EndType.etClosedPolygon
    );
    const solution = new CLIPPER.Paths();
    offset.Execute(solution, deltaInt);
    const cleaned = CLIPPER.Clipper.CleanPolygons(solution, 1.415);
    return cleaned.map(path => path.map(fromClipperPoint));
}

// ============================================================
// 5b. УТИЛИТЫ: DOM-чтение, зеркало, оценка времени
// ============================================================

// Безопасное чтение полей интерфейса (генераторы не должны падать,
// если поле отсутствует — например в автотестах).
function domNum(id, def) {
    const el = document.getElementById(id);
    if (!el) return def;
    const v = parseFloat(el.value);
    return isFinite(v) ? v : def;
}
function domChk(id, def) {
    const el = document.getElementById(id);
    return el ? !!el.checked : def;
}

// Центр платы по X (по всей геометрии DXF) — ось зеркалирования
// для двусторонних плат. Результат — в единицах DXF.
function getBoardCenterX(parsed) {
    let minX = Infinity, maxX = -Infinity;
    const acc = (x) => { if (isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x; } };
    parsed.entities.forEach(ent => {
        if (ent.type === 'CIRCLE' || ent.type === 'ARC') {
            if (isFinite(ent.cx)) { acc(ent.cx - (ent.r || 0)); acc(ent.cx + (ent.r || 0)); }
        } else if (ent.type === 'LINE') {
            if (ent.p1) acc(ent.p1.x);
            if (ent.p2) acc(ent.p2.x);
        } else if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
            (ent.points || []).forEach(p => acc(p.x));
        } else if (ent.type === 'HATCH') {
            (ent.loops || []).forEach(lp => (lp || []).forEach(p => acc(p.x)));
        }
    });
    return (isFinite(minX) && isFinite(maxX)) ? (minX + maxX) / 2 : 0;
}

// Зеркалирование набора точек по вертикальной оси X = centerX
function mirrorPointsX(points, centerX) {
    return points.map(p => ({ x: 2 * centerX - p.x, y: p.y }));
}

// Человекочитаемая длительность
function formatDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '—';
    const total = Math.round(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return h + ' ч ' + m + ' мин';
    if (m > 0) return m + ' мин ' + s + ' с';
    return s + ' с';
}

// Оценка времени обработки по массиву moves (мм).
//   * cut / link  — рабочая подача (feed)
//   * вниз по Z   — врезание (plungeFeed), вверх — ускоренный ход
//   * XY ускоренным ходом — rapidFeed
function estimateTime(moves, opts) {
    const feed       = (opts.feed > 0)       ? opts.feed       : 0;
    const plungeFeed = (opts.plungeFeed > 0) ? opts.plungeFeed : 0;
    const rapidFeed  = (opts.rapidFeed > 0)  ? opts.rapidFeed  : 0;
    let tCut = 0, tRapid = 0, tPlunge = 0;
    let cutLen = 0, rapidLen = 0, plungeLen = 0;

    moves.forEach(m => {
        const d  = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
        const dz = Math.abs(m.z2 - m.z1);
        if (m.type === 'cut' || m.type === 'link') {
            cutLen += d;
            if (feed > 0) tCut += d / feed * 60;
        } else if (m.type === 'plunge' || m.type === 'drill') {
            plungeLen += d + dz;
            if (plungeFeed > 0) tPlunge += (d + dz) / plungeFeed * 60;
        } else { // rapid
            if (m.z2 < m.z1 - 1e-9) {          // движение вниз = врезание
                plungeLen += d + dz;
                if (plungeFeed > 0) tPlunge += dz / plungeFeed * 60;
                if (rapidFeed > 0)  tRapid  += d / rapidFeed * 60;
            } else {                            // холостой ход / отвод
                rapidLen += d + dz;
                if (rapidFeed > 0) tRapid += (d + dz) / rapidFeed * 60;
            }
        }
    });

    return { seconds: tCut + tRapid + tPlunge, tCut, tRapid, tPlunge, cutLen, rapidLen, plungeLen };
}

// ============================================================
// 5c. ГЕОМЕТРИЯ ЗАЗОРОВ (расстояние между контурами)
// ============================================================

function cross2(ax, ay, bx, by) { return ax * by - ay * bx; }

// Строгое пересечение отрезков: касание концами/в вершине не считается
function segCrossProper(p1, p2, p3, p4) {
    const d1 = cross2(p4.x - p3.x, p4.y - p3.y, p1.x - p3.x, p1.y - p3.y);
    const d2 = cross2(p4.x - p3.x, p4.y - p3.y, p2.x - p3.x, p2.y - p3.y);
    const d3 = cross2(p2.x - p1.x, p2.y - p1.y, p3.x - p1.x, p3.y - p1.y);
    const d4 = cross2(p2.x - p1.x, p2.y - p1.y, p4.x - p1.x, p4.y - p1.y);
    const eps = 1e-12;
    return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
           ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

// Ближайшая точка на отрезке [a,b] к точке p
function closestPtOnSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const denom = abx * abx + aby * aby;
    if (denom < 1e-18) return { x: a.x, y: a.y };
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / denom;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return { x: a.x + t * abx, y: a.y + t * aby };
}

// Минимальное расстояние между двумя отрезками + середина этого места
function segSegDistance(p1, p2, q1, q2) {
    if (segCrossProper(p1, p2, q1, q2)) {
        return { d: 0, p: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
    }
    const cands = [
        [p1, closestPtOnSeg(p1, q1, q2)],
        [p2, closestPtOnSeg(p2, q1, q2)],
        [closestPtOnSeg(q1, p1, p2), q1],
        [closestPtOnSeg(q2, p1, p2), q2]
    ];
    let best = Infinity, bp = null;
    cands.forEach(cd => {
        const dd = Math.hypot(cd[0].x - cd[1].x, cd[0].y - cd[1].y);
        if (dd < best) { best = dd; bp = { x: (cd[0].x + cd[1].x) / 2, y: (cd[0].y + cd[1].y) / 2 }; }
    });
    return { d: best, p: bp };
}

function bboxOfPoly(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

function bboxGap(a, b) {
    const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
    const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
    return Math.hypot(dx, dy);
}

// Минимальный зазор между двумя НЕпересекающимися полигонами.
// cap — верхняя граница поиска: если ближе cap ничего нет, вернётся cap.
function minGapBetweenPolys(A, B, cap) {
    const bbB = bboxOfPoly(B);
    let best = cap, bestPt = null;
    for (let i = 0; i < A.length; i++) {
        const a1 = A[i], a2 = A[(i + 1) % A.length];
        const axMin = Math.min(a1.x, a2.x), axMax = Math.max(a1.x, a2.x);
        const ayMin = Math.min(a1.y, a2.y), ayMax = Math.max(a1.y, a2.y);
        const g0x = Math.max(0, Math.max(axMin - bbB.maxX, bbB.minX - axMax));
        const g0y = Math.max(0, Math.max(ayMin - bbB.maxY, bbB.minY - ayMax));
        if (Math.hypot(g0x, g0y) >= best) continue;
        for (let j = 0; j < B.length; j++) {
            const b1 = B[j], b2 = B[(j + 1) % B.length];
            const bxMin = Math.min(b1.x, b2.x), bxMax = Math.max(b1.x, b2.x);
            const byMin = Math.min(b1.y, b2.y), byMax = Math.max(b1.y, b2.y);
            const hx = Math.max(0, Math.max(axMin - bxMax, bxMin - axMax));
            const hy = Math.max(0, Math.max(ayMin - byMax, byMin - ayMax));
            if (Math.hypot(hx, hy) >= best) continue;
            const r = segSegDistance(a1, a2, b1, b2);
            if (r.d < best) { best = r.d; bestPt = r.p; }
        }
    }
    return { d: best, pt: bestPt };
}

// Безопасен ли переход от точки a к точке b без подъёма инструмента:
// прямая не должна пересекать ни один контур фрезеровки.
function linkIsSafe(a, b, chains) {
    if (!a || !b) return false;
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const pad = 1e-9;
    for (let ci = 0; ci < chains.length; ci++) {
        const c = chains[ci];
        if (!c || c.length < 2) continue;
        let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
        for (let k = 0; k < c.length; k++) {
            const q = c[k];
            if (q.x < cMinX) cMinX = q.x;
            if (q.y < cMinY) cMinY = q.y;
            if (q.x > cMaxX) cMaxX = q.x;
            if (q.y > cMaxY) cMaxY = q.y;
        }
        if (cMaxX < minX - pad || cMinX > maxX + pad ||
            cMaxY < minY - pad || cMinY > maxY + pad) continue;
        for (let k = 0; k < c.length; k++) {
            const q1 = c[k], q2 = c[(k + 1) % c.length];
            if (segCrossProper(a, b, q1, q2)) return false;
        }
    }
    return true;
}

// ============================================================
// 5d. DRC-lite: анализ зазоров между медными зонами
// ============================================================
// Берём объединённые (union) медные зоны — так дубли геометрии
// (POLYLINE + идентичный HATCH) не дают ложный «нулевой зазор»,
// а зазоры считаются между реально разными проводниками.
function analyzeDRC(parsed, isVisible, defaultLineWidth, opts) {
    const o = opts || {};
    const maxGap = (o.maxGap > 0) ? o.maxGap : 0.5;
    const toolD  = (o.toolD > 0) ? o.toolD : 0;

    const t0 = performance.now();
    const raw = collectMillingPolygons(parsed, isVisible, defaultLineWidth);
    const tExtract = performance.now();
    const union = clipperUnion(raw);
    const tUnion = performance.now();

    const zones = [];
    let sumArea = 0;
    union.forEach(poly => {
        if (poly.length < 3) return;
        const sa = signedArea(poly);
        sumArea += sa;
        zones.push({ poly, bb: bboxOfPoly(poly), area: Math.abs(sa), signed: sa });
    });

    // Ориентация «внешних» контуров определяется автоматически:
    // сумма площадей меди всегда положительна (+внешние, −дырки).
    const outerSign = (sumArea >= 0) ? 1 : -1;
    const outers = [];
    zones.forEach((z, zi) => { if (z.signed * outerSign > 0) outers.push({ z, zi }); });

    const pairs = [];
    let tested = 0, touching = 0;
    // Радиус поиска покрывает и порог отчёта, и диаметр фрезы: иначе
    // предупреждение «фреза не влезает» недосчитало бы пары, если фреза
    // шире порога отчёта.
    const searchGap = (toolD > 0) ? Math.max(maxGap, toolD) : maxGap;
    for (let i = 0; i < outers.length; i++) {
        for (let j = i + 1; j < outers.length; j++) {
            const A = outers[i].z, B = outers[j].z;
            if (bboxGap(A.bb, B.bb) >= searchGap) continue;   // быстрый отсев
            tested++;
            const g = minGapBetweenPolys(A.poly, B.poly, searchGap);
            if (g.d < searchGap && g.pt) {
                if (g.d <= 0) touching++;                  // контуры сомкнуты
                pairs.push({ d: g.d, pt: g.pt, ai: outers[i].zi, bi: outers[j].zi });
            }
        }
    }
    pairs.sort((a, b) => a.d - b.d);

    // Отчёт — только пары ближе порога; проход фрезы — все найденные пары.
    const report = (maxGap < searchGap) ? pairs.filter(p => p.d < maxGap) : pairs;
    const nearTool = (toolD > 0) ? pairs.filter(p => p.d < toolD).length : 0;

    const tEnd = performance.now();
    return {
        rawCount: raw.length,
        zoneCount: zones.length,
        outerCount: outers.length,
        copperArea: Math.abs(sumArea),
        pairs: report,
        zones: zones,
        touching: touching,
        tested: tested,
        minGap: report.length ? report[0].d : Infinity,
        nearTool: nearTool,
        maxGap: maxGap,
        searchGap: searchGap,
        toolD: toolD,
        ms: tEnd - t0,
        times: { extract: tExtract - t0, union: tUnion - tExtract, pairs: tEnd - tUnion }
    };
}

// ============================================================
// 6. ПАЙПЛАЙН ФРЕЗЕРОВКИ
// ============================================================
function generateVectorToolpath(params) {
    const { toolRadius, stepCount, stepOver, onlyVis, invertY, scale, defaultLineWidth, mirrorX } = params;
    const parsed = window._parsedDXF;
    if (!parsed) return { paths: [], stages: [] };

    const isVisible = name => !onlyVis || !layerGroups[name] || layerGroups[name].visible;

    const stages = [];
    let t = performance.now();

    const rawPolygons = collectMillingPolygons(parsed, isVisible, defaultLineWidth);
    stages.push({ name: 'extract', time: performance.now() - t, count: rawPolygons.length });
    if (rawPolygons.length === 0) return { paths: [], stages };

    t = performance.now();
    const unionResult = clipperUnion(rawPolygons);
    stages.push({ name: 'union', time: performance.now() - t, count: unionResult.length });
    if (unionResult.length === 0) return { paths: [], stages };

    const allPaths = [];
    let current = unionResult;

    for (let k = 0; k <= stepCount; k++) {
        t = performance.now();
        const delta = (k === 0) ? toolRadius : stepOver;
        const next = clipperOffset(current, delta);
        stages.push({ name: `offset_${k}`, time: performance.now() - t, count: next.length });
        if (next.length === 0) break;
        next.forEach(path => allPaths.push(path));
        current = next;
    }

    let mmPaths = allPaths.map(path => {
        return path.map(p => ({
            x: p.x * scale,
            y: (invertY ? -p.y : p.y) * scale
        }));
    }).filter(path => path.length >= 3 && !isDegenerateContour(path));

    // Зеркало по X относительно центра платы (для нижнего слоя
    // двусторонней платы — деталь остаётся на своём месте).
    if (mirrorX) {
        const centerMm = (window._boardCenterX || 0) * scale;
        mmPaths = mmPaths.map(path => mirrorPointsX(path, centerMm));
    }

    return { paths: mmPaths, stages };
}

// ============================================================
// 7. ОПТИМИЗАЦИЯ ПОРЯДКА КОНТУРОВ (nearest-neighbor)
// ============================================================

// bbox-центр контура
function chainCenter(c) {
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const p of c) {
        if (p.x < xMin) xMin = p.x;
        if (p.y < yMin) yMin = p.y;
        if (p.x > xMax) xMax = p.x;
        if (p.y > yMax) yMax = p.y;
    }
    return { cx: (xMin + xMax) / 2, cy: (yMin + yMax) / 2 };
}

// Жадный обход контуров:
//   1) каждый раз берём ближайший контур по bbox-центру,
//   2) внутри контура — ближайшая точка входа,
//   3) направление обхода — короче от точки входа.
function orderChainsNearestNeighbor(chains, startX = 0, startY = 0) {
    const rest = chains.slice();
    const ordered = [];
    let curX = startX, curY = startY;

    while (rest.length) {
        // 1. Ближайший контур
        let bestIdx = 0, bestD = Infinity;
        for (let i = 0; i < rest.length; i++) {
            const c = chainCenter(rest[i]);
            const d = Math.hypot(c.cx - curX, c.cy - curY);
            if (d < bestD) { bestD = d; bestIdx = i; }
        }
        const chain = rest.splice(bestIdx, 1)[0];
        const n = chain.length;

        // 2. Ближайшая точка входа
        let entryIdx = 0, entryD = Infinity;
        for (let i = 0; i < n; i++) {
            const d = Math.hypot(chain[i].x - curX, chain[i].y - curY);
            if (d < entryD) { entryD = d; entryIdx = i; }
        }

        // 3. Направление обхода: по или против часовой
        const nextPt = chain[(entryIdx + 1) % n];
        const prevPt = chain[(entryIdx - 1 + n) % n];
        const dNext = Math.hypot(nextPt.x - chain[entryIdx].x, nextPt.y - chain[entryIdx].y);
        const dPrev = Math.hypot(prevPt.x - chain[entryIdx].x, prevPt.y - chain[entryIdx].y);

        let rotated;
        if (dNext <= dPrev) {
            rotated = chain.slice(entryIdx).concat(chain.slice(0, entryIdx));
        } else {
            rotated = chain.slice(0, entryIdx + 1).reverse()
                .concat(chain.slice(entryIdx + 1).reverse());
        }

        ordered.push(rotated);
        curX = rotated[rotated.length - 1].x;
        curY = rotated[rotated.length - 1].y;
    }
    return ordered;
}

// ============================================================
// 8. G-CODE ФРЕЗЕРОВКИ
// ============================================================
function buildMovesAndGCode(chains, safeZ, depth, totalPasses, opts) {
    const o = opts || {};
    const moves = [];
    const gcode = [];

    // Режимы резания: приоритет у opts (интерфейс передаёт их явно),
    // затем поля формы, затем значения по умолчанию.
    const feed         = (isFinite(o.feed) && o.feed > 0) ? o.feed : domNum('cnc-feed', 600);
    const plungeFeed   = (isFinite(o.plungeFeed) && o.plungeFeed > 0) ? o.plungeFeed : Math.max(1, feed / 2);
    const spindle      = (isFinite(o.spindle) && o.spindle >= 0) ? o.spindle : domNum('cnc-spindle', 1000);
    const rapidFeed    = (isFinite(o.rapidFeed) && o.rapidFeed > 0) ? o.rapidFeed : domNum('cnc-rapid-feed', 3000);
    const smartRetract = (typeof o.smartRetract === 'boolean') ? o.smartRetract : domChk('cnc-smart-retract', true);

    gcode.push('(DXF to G-code — mill, optimized)');
    gcode.push('G21 ; мм');
    gcode.push('G90 ; абсолютные координаты');
    gcode.push('G94 ; подача в мм/мин');
    gcode.push('G17 ; плоскость XY');
    gcode.push('G0 Z' + safeZ.toFixed(3));
    gcode.push('M3 S' + spindle.toFixed(0) + ' ; шпиндель вкл');
    gcode.push('');

    const passes = [];
    for (let p = 1; p <= totalPasses; p++) passes.push(depth * (p / totalPasses));

    // ----- ОПТИМИЗАЦИЯ: порядок обхода контуров -----
    // Медь срезается, а не прорезается насквозь → сортировка
    // "внутренние/внешние" не нужна. Только минимизация G0-переходов.
    chains = orderChainsNearestNeighbor(chains, 0, 0);

    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    chains.forEach(ch => ch.forEach(pt => {
        if (pt.x < xMin) xMin = pt.x;
        if (pt.y < yMin) yMin = pt.y;
        if (pt.x > xMax) xMax = pt.x;
        if (pt.y > yMax) yMax = pt.y;
    }));
    gcode.push('(Габариты: X ' + xMin.toFixed(2) + '..' + xMax.toFixed(2) +
               ', Y ' + yMin.toFixed(2) + '..' + yMax.toFixed(2) + ')');
    gcode.push('(Проходов: ' + totalPasses + ', конечная Z: ' + depth + ')');
    gcode.push('(Контуров: ' + chains.length + ', порядок: nearest-neighbor)');
    gcode.push('(Подача: ' + feed.toFixed(0) + ' мм/мин, врезание: ' + plungeFeed.toFixed(0) +
               ' мм/мин, S' + spindle.toFixed(0) + ')');
    gcode.push('(Умный отвод: ' + (smartRetract ? 'вкл' : 'выкл') + ')');
    gcode.push('');

    let currentXY = { x: 0, y: 0 };
    let lastEnd = null;
    let lastCutZ = 0;
    let totalLen = 0;
    let linkCount = 0;
    let retractCount = 0;
    let toolDown = false;

    passes.forEach((cutZ, pi) => {
        // Проходы идут на разную глубину, поэтому первый контур каждого
        // прохода всегда требует подъёма и нового врезания.
        toolDown = false;

        chains.forEach((chain, ci) => {
            if (chain.length < 3) return;
            const closed = [...chain, chain[0]];
            const p0 = closed[0];

            const linkSafe = smartRetract && toolDown && linkIsSafe(lastEnd, p0, chains);

            if (linkSafe) {
                // Прямая до следующего контура не пересекает медь —
                // можно остаться на глубине (экономия подъёмов).
                linkCount++;
                gcode.push('(Проход ' + (pi + 1) + '/' + passes.length + ', контур ' + (ci + 1) +
                           ', точек: ' + closed.length + ' — переход без отвода)');
                gcode.push('G1 X' + p0.x.toFixed(3) + ' Y' + p0.y.toFixed(3) + ' F' + feed.toFixed(0));
                moves.push({ type: 'link', x1: currentXY.x, y1: currentXY.y, z1: cutZ, x2: p0.x, y2: p0.y, z2: cutZ });
                totalLen += Math.hypot(p0.x - currentXY.x, p0.y - currentXY.y);
            } else {
                retractCount++;
                gcode.push('(Проход ' + (pi + 1) + '/' + passes.length + ', контур ' + (ci + 1) +
                           ', точек: ' + closed.length + ')');
                gcode.push('G0 Z' + safeZ.toFixed(3));
                gcode.push('G0 X' + p0.x.toFixed(3) + ' Y' + p0.y.toFixed(3));

                moves.push({ type: 'rapid', x1: currentXY.x, y1: currentXY.y, z1: safeZ, x2: p0.x, y2: p0.y, z2: safeZ });

                gcode.push('G1 Z' + cutZ.toFixed(3) + ' F' + plungeFeed.toFixed(0));
                moves.push({ type: 'rapid', x1: p0.x, y1: p0.y, z1: safeZ, x2: p0.x, y2: p0.y, z2: cutZ });
                moves.push({ type: 'plunge', x1: p0.x, y1: p0.y, z1: cutZ, x2: p0.x, y2: p0.y, z2: cutZ });
            }

            for (let i = 1; i < closed.length; i++) {
                const prev = closed[i - 1], p = closed[i];
                gcode.push('G1 X' + p.x.toFixed(3) + ' Y' + p.y.toFixed(3) + ' F' + feed.toFixed(0));
                moves.push({ type: 'cut', x1: prev.x, y1: prev.y, z1: cutZ, x2: p.x, y2: p.y, z2: cutZ });
                totalLen += Math.hypot(p.x - prev.x, p.y - prev.y);
            }

            // Отвод выполняется не сразу, а перед следующим переходом —
            // только так «умный отвод» может пропустить безопасный подъём.
            lastEnd = closed[closed.length - 1];
            currentXY = { x: lastEnd.x, y: lastEnd.y };
            lastCutZ = cutZ;
            toolDown = true;
            gcode.push('');
        });
    });

    if (toolDown) {
        gcode.push('G0 Z' + safeZ.toFixed(3));
        moves.push({ type: 'rapid', x1: currentXY.x, y1: currentXY.y, z1: lastCutZ, x2: currentXY.x, y2: currentXY.y, z2: safeZ });
        gcode.push('');
    }

    const est = estimateTime(moves, { feed, plungeFeed, rapidFeed });

    gcode.push('M5');
    gcode.push('G0 X0 Y0');
    gcode.push('M30');
    gcode.push('(Итого длина резания: ' + totalLen.toFixed(2) + ' мм)');
    gcode.push('(Переходов без отвода: ' + linkCount + ', с отводом: ' + retractCount + ')');
    gcode.push('(Время ≈ ' + formatDuration(est.seconds) + ': резание ' + formatDuration(est.tCut) +
               ', врезания ' + formatDuration(est.tPlunge) + ', холостой ход ' + formatDuration(est.tRapid) + ')');
    return { moves, gcode: gcode.join('\n'), est, stats: { linkCount, retractCount, totalLen } };
}

// ============================================================
// 9. ВИЗУАЛИЗАЦИЯ ФРЕЗЕРОВКИ
// ============================================================
const toolpathMaterials = {
    rapid: new THREE.LineDashedMaterial({ color: 0xffcc00, dashSize: 1.5, gapSize: 1.0, transparent: true, opacity: 0.6 }),
    cut: new THREE.LineBasicMaterial({ color: 0x33ff66 }),
    plunge: new THREE.MeshBasicMaterial({ color: 0xff3355 })
};

function clearToolpath() {
    while (toolpathGroup.children.length) {
        const c = toolpathGroup.children.pop();
        if (c.geometry) c.geometry.dispose();
    }
}

function visualizeToolpath(moves) {
    clearToolpath();
    const rapid = [], cut = [], plunge = [];
    moves.forEach(m => {
        if (m.type === 'rapid') rapid.push(m.x1, m.y1, m.z1, m.x2, m.y2, m.z2);
        else if (m.type === 'cut' || m.type === 'link') cut.push(m.x1, m.y1, m.z1, m.x2, m.y2, m.z2);
        else plunge.push([m.x1, m.y1, m.z1]);
    });

    if (rapid.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(rapid, 3));
        const l = new THREE.LineSegments(g, toolpathMaterials.rapid);
        l.computeLineDistances();
        toolpathGroup.add(l);
    }
    if (cut.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(cut, 3));
        toolpathGroup.add(new THREE.LineSegments(g, toolpathMaterials.cut));
    }
    if (plunge.length) {
        const sph = new THREE.SphereGeometry(0.1, 6, 6);
        plunge.forEach(([x, y, z]) => {
            const m = new THREE.Mesh(sph, toolpathMaterials.plunge);
            m.position.set(x, y, z);
            toolpathGroup.add(m);
        });
    }
    toolpathGroup.visible = document.getElementById('cnc-show-path').checked;
}

// ============================================================
// 10. ГЕНЕРАЦИЯ G-CODE ФРЕЗЕРОВКИ
// ============================================================
function generateGCode() {
    if (!window._parsedDXF) { alert('Сначала загрузите DXF файл.'); return; }
    if (!CLIPPER) { alert('Clipper не загружен.'); return; }

    const depth     = parseFloat(document.getElementById('cnc-depth').value)  || -0.5;
    const passes    = Math.max(1, parseInt(document.getElementById('cnc-passes').value) || 1);
    const safeZ     = parseFloat(document.getElementById('cnc-safe-z').value) || 2;
    const scale     = parseFloat(document.getElementById('cnc-scale').value)  || 1;
    const toolR     = parseFloat(document.getElementById('cnc-tool-r').value) || 0;
    const stepCount = Math.max(0, parseInt(document.getElementById('cnc-step-count').value) || 0);
    const stepOver  = Math.max(0.01, parseFloat(document.getElementById('cnc-step-over').value) || 0.5);
    const invertY   = document.getElementById('cnc-invert-y').checked;
    const onlyVis   = document.getElementById('cnc-only-visible').checked;
    const lineWidth = Math.max(0, parseFloat(document.getElementById('cnc-line-width').value) || 0.1);
    const mirrorX   = document.getElementById('cnc-mirror-x').checked;
    const feed       = Math.max(1,   domNum('cnc-feed', 600));
    const plungeFeed = Math.max(1,   domNum('cnc-plunge-feed', 100));
    const spindle    = Math.max(0,   domNum('cnc-spindle', 1000));
    const rapidFeed  = Math.max(1,   domNum('cnc-rapid-feed', 3000));
    const smartRetract = domChk('cnc-smart-retract', true);

    const groups = Object.values(layerGroups).filter(g => !onlyVis || g.visible);
    if (groups.length === 0) { alert('Нет видимых слоёв.'); return; }

    const info = document.getElementById('cnc-info');
    const loadingEl = document.getElementById('loading');

    loadingEl.style.display = 'block';
    info.innerText = 'Построение векторного пути...';

    setTimeout(() => {
        try {
            const t0 = performance.now();
            const { paths, stages } = generateVectorToolpath({
                toolRadius: toolR, stepCount, stepOver, onlyVis, invertY, scale,
                defaultLineWidth: lineWidth, mirrorX
            });
            const t1 = performance.now();
            console.log('[MILL] stages:', stages);

            if (paths.length === 0) {
                loadingEl.style.display = 'none';
                alert('Не удалось построить контуры.');
                return;
            }

            info.innerText = 'Генерация G-code...';
            const { moves, gcode, est, stats } = buildMovesAndGCode(paths, safeZ, depth, passes, {
                feed, plungeFeed, spindle, rapidFeed, smartRetract
            });
            window._lastGCode = gcode;
            visualizeToolpath(moves);
            document.getElementById('cnc-download').disabled = false;

            const stageStr = stages.map(s => s.name + ': ' + s.time.toFixed(0) + 'ms').join(' | ');

            info.innerHTML =
                '✓ ' + paths.length + ' контуров, ' + passes + ' проход(ов)<br>' +
                'Радиус: ' + toolR + ' мм, оффсет: ' + stepCount + ', шаг: ' + stepOver + ' мм<br>' +
                'Резание: ' + est.cutLen.toFixed(1) + ' мм | Холостой ход: ' + est.rapidLen.toFixed(1) + ' мм<br>' +
                'Подача: ' + feed.toFixed(0) + ' | врезание: ' + plungeFeed.toFixed(0) +
                ' | S' + spindle.toFixed(0) + ' об/мин<br>' +
                (smartRetract
                    ? 'Умный отвод: ' + stats.linkCount + ' переходов без подъёма, ' +
                      stats.retractCount + ' с отводом<br>'
                    : 'Умный отвод выключен (' + stats.retractCount + ' отводов)<br>') +
                '<b>Оценка времени: ~' + formatDuration(est.seconds) + '</b>' +
                ' (резание ' + formatDuration(est.tCut) +
                ', врезания ' + formatDuration(est.tPlunge) +
                ', холостой ' + formatDuration(est.tRapid) + ')<br>' +
                (mirrorX ? 'Зеркало по X: вкл (центр X = ' +
                    ((window._boardCenterX || 0)).toFixed(3) + ' ед.)<br>' : '') +
                stageStr;

            loadingEl.style.display = 'none';
        } catch (err) {
            console.error(err);
            loadingEl.style.display = 'none';
            info.innerText = 'Ошибка: ' + err.message;
            alert('Ошибка: ' + err.message);
        }
    }, 50);
}

// ============================================================
// 11. ИЗВЛЕЧЕНИЕ ОТВЕРСТИЙ
// ============================================================
function extractHoles(parsed, onlyVisible, mergeLayerDups) {
    const holes = [];
    const seen = new Set();

    const layerVisible = (name) => {
        if (!onlyVisible) return true;
        const g = layerGroups[name];
        return !g || g.visible;
    };

    const pushHole = (layer, cx, cy, r, source) => {
        if (!isFinite(cx) || !isFinite(cy) || !(r > 0)) return;
        const key = cx.toFixed(2) + '|' + cy.toFixed(2) + '|' + (r * 2).toFixed(2);
        if (mergeLayerDups && seen.has(key)) return;
        seen.add(key);
        holes.push({ layer, cx, cy, r, d: r * 2, source });
    };

    parsed.entities.forEach(ent => {
        if (ent.type !== 'CIRCLE') return;
        const layer = ent.layer || '0';
        if (!layerVisible(layer)) return;
        if (ent.r > 0) pushHole(layer, ent.cx, ent.cy, ent.r, 'CIRCLE');
    });

    parsed.entities.forEach(ent => {
        if (ent.type !== 'LWPOLYLINE') return;
        const layer = ent.layer || '0';
        if (!layerVisible(layer)) return;
        if (ent.points.length !== 2) return;
        const p1 = ent.points[0], p2 = ent.points[1];
        const b1 = Math.abs(p1.bulge || 0);
        const b2 = Math.abs(p2.bulge || 0);
        if (b1 > 0.99 && b2 > 0.99) {
            const cx = (p1.x + p2.x) / 2;
            const cy = (p1.y + p2.y) / 2;
            const r  = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
            pushHole(layer, cx, cy, r, 'LWPOLYLINE-arc');
        }
    });

    parsed.entities.forEach(ent => {
        if (ent.type !== 'HATCH') return;
        const layer = ent.layer || '0';
        if (!layerVisible(layer)) return;
        if (!ent.loops || ent.loops.length === 0) return;

        ent.loops.forEach(loop => {
            if (loop.length !== 2) return;
            const p1 = loop[0], p2 = loop[1];
            const b1 = Math.abs(p1.bulge || 0);
            const b2 = Math.abs(p2.bulge || 0);
            if (b1 > 0.99 && b2 > 0.99) {
                const cx = (p1.x + p2.x) / 2;
                const cy = (p1.y + p2.y) / 2;
                const r  = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
                pushHole(layer, cx, cy, r, 'HATCH-circle');
            }
        });
    });

    console.log('[DRILL] holes extracted:', holes.length);
    return holes;
}

// ============================================================
// 12. ОПТИМИЗАЦИЯ МАРШРУТА СВЕРЛОВКИ (nearest-neighbor + 2-opt)
// ============================================================
function orderHolesNearestNeighbor(holes) {
    if (holes.length <= 1) return holes.slice();

    // 1. Жадный старт
    const rest = holes.slice();
    const ordered = [rest.shift()];
    while (rest.length) {
        const last = ordered[ordered.length - 1];
        let bestIdx = 0, bestD = Infinity;
        for (let i = 0; i < rest.length; i++) {
            const d = Math.hypot(rest[i].cx - last.cx, rest[i].cy - last.cy);
            if (d < bestD) { bestD = d; bestIdx = i; }
        }
        ordered.push(rest.splice(bestIdx, 1)[0]);
    }

    // 2. 2-opt: устраняем пересечения рёбер
    const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
    let improved = true;
    let iter = 0;
    const MAX_ITER = 2000;

    while (improved && iter++ < MAX_ITER) {
        improved = false;
        for (let i = 1; i < ordered.length - 1; i++) {
            for (let j = i + 1; j < ordered.length; j++) {
                const a = ordered[i - 1], b = ordered[i];
                const c = ordered[j], d = (j + 1 < ordered.length) ? ordered[j + 1] : null;

                const before = dist(a, b) + (d ? dist(c, d) : 0);
                const after  = dist(a, c) + (d ? dist(b, d) : 0);

                if (after + 1e-9 < before) {
                    let lo = i, hi = j;
                    while (lo < hi) {
                        const tmp = ordered[lo];
                        ordered[lo] = ordered[hi];
                        ordered[hi] = tmp;
                        lo++; hi--;
                    }
                    improved = true;
                }
            }
        }
    }
    return ordered;
}

function groupHolesByTool(holes, toolStep = 0.1) {
    const map = new Map();
    holes.forEach(h => {
        const dKey = Math.ceil(h.d / toolStep - 1e-6) * toolStep;
        const key = dKey.toFixed(3);
        if (!map.has(key)) map.set(key, { d: dKey, r: dKey / 2, holes: [] });
        map.get(key).holes.push(h);
    });
    const tools = [...map.values()].sort((a, b) => a.d - b.d);
    tools.forEach(t => { t.holes = orderHolesNearestNeighbor(t.holes); });
    return tools;
}

// ============================================================
// 13. G-CODE СВЕРЛОВКИ
// ============================================================
function buildDrillGCode(tools, opts) {
    const { safeZ, depth, plungeFeed, dwell, mode, peck, invertY, scale } = opts;
    const spindle   = (isFinite(opts.spindle) && opts.spindle >= 0) ? opts.spindle : domNum('drill-spindle', 1000);
    const rapidFeed = (isFinite(opts.rapidFeed) && opts.rapidFeed > 0) ? opts.rapidFeed : domNum('drill-rapid-feed', 3000);
    const mirrorX   = !!opts.mirrorX;
    const centerX   = isFinite(opts.centerX) ? opts.centerX : 0;

    // DXF → координаты G-code: масштаб, зеркало по X, инверсия Y
    const toX = (cx) => (mirrorX ? (2 * centerX - cx) : cx) * scale;
    const toY = (cy) => (invertY ? -cy : cy) * scale;

    const g = [];
    g.push('(Drill G-code — auto generated, optimized)');
    g.push('G21 ; мм');
    g.push('G90 ; абсолютные координаты');
    g.push('G94 ; подача в мм/мин');
    g.push('G17 ; плоскость XY');
    g.push('G0 Z' + safeZ.toFixed(3));
    g.push('M5 ; шпиндель выкл');
    g.push('');

    const moves = [];
    let totalHoles = 0;
    let cur = { x: 0, y: 0 };

    tools.forEach((tool, ti) => {
        const d = tool.d;
        g.push('(Инструмент T' + (ti + 1) + ' — Ø' + d.toFixed(2) + ' мм, отверстий: ' + tool.holes.length + ')');
        g.push('T' + (ti + 1) + ' M6 ; смена инструмента');
        g.push('S' + spindle.toFixed(0) + ' M3');
        g.push('G0 Z' + safeZ.toFixed(3));
        g.push('');

        // Переупорядочить отверстия, начиная с ближайшего к текущей позиции
        if (tool.holes.length > 1) {
            let bestIdx = 0, bestD = Infinity;
            for (let i = 0; i < tool.holes.length; i++) {
                const h = tool.holes[i];
                const X = toX(h.cx);
                const Y = toY(h.cy);
                const dd = Math.hypot(X - cur.x, Y - cur.y);
                if (dd < bestD) { bestD = dd; bestIdx = i; }
            }
            if (bestIdx > 0) {
                const h = tool.holes.splice(bestIdx, 1)[0];
                tool.holes.unshift(h);
            }
        }

        tool.holes.forEach((h) => {
            const X = toX(h.cx);
            const Y = toY(h.cy);

            g.push('G0 X' + X.toFixed(3) + ' Y' + Y.toFixed(3));
            moves.push({ type: 'rapid',
                x1: cur.x, y1: cur.y, z1: safeZ,
                x2: X,     y2: Y,     z2: safeZ });

            if (mode === 'peck' && peck > 0) {
                const totalDepth = Math.abs(depth);
                const nSteps = Math.max(1, Math.ceil(totalDepth / peck));
                for (let s = 1; s <= nSteps; s++) {
                    const zTarget = -Math.min(s * peck, totalDepth);
                    g.push('G1 Z' + zTarget.toFixed(3) + ' F' + plungeFeed.toFixed(0));
                    if (zTarget > depth + 1e-6) {
                        g.push('G0 Z' + safeZ.toFixed(3));
                        g.push('G0 Z' + (zTarget + peck * 0.5).toFixed(3));
                    }
                }
                if (Math.abs(nSteps * peck - totalDepth) > 1e-6) {
                    g.push('G1 Z' + depth.toFixed(3) + ' F' + plungeFeed.toFixed(0));
                }
                if (dwell > 0) g.push('G4 P' + dwell.toFixed(2));
                g.push('G0 Z' + safeZ.toFixed(3));
            } else {
                g.push('G1 Z' + depth.toFixed(3) + ' F' + plungeFeed.toFixed(0));
                if (dwell > 0) g.push('G4 P' + dwell.toFixed(2));
                g.push('G0 Z' + safeZ.toFixed(3));
            }

            moves.push({ type: 'drill',
                x1: X, y1: Y, z1: safeZ,
                x2: X, y2: Y, z2: depth });

            cur = { x: X, y: Y };
            totalHoles++;
            g.push('');
        });

        g.push('M5');
        g.push('');
    });

    g.push('G0 Z' + safeZ.toFixed(3));
    g.push('G0 X0 Y0');
    g.push('M30');

    // --- Оценка времени обработки ---
    const est = estimateTime(moves, { feed: 0, plungeFeed, rapidFeed });
    // Пауза (G4) у каждого отверстия
    est.dwell = (dwell > 0) ? dwell * totalHoles : 0;
    // Смена инструмента
    est.toolChange = (opts.toolChange > 0) ? opts.toolChange * tools.length : 0;
    // Приблизительные доп. подъёмы при сверлении с выводом стружки (peck)
    if (mode === 'peck' && peck > 0) {
        const nRetracts = Math.max(0, Math.ceil(Math.abs(depth) / peck) - 1);
        est.peek = (rapidFeed > 0) ? (nRetracts * totalHoles * (2 * safeZ + peck)) / rapidFeed * 60 : 0;
    } else {
        est.peek = 0;
    }
    est.seconds += est.dwell + est.toolChange + est.peek;

    g.push('(Всего отверстий: ' + totalHoles + ')');
    g.push('(Инструментов: ' + tools.length + ')');
    g.push('(Время ≈ ' + formatDuration(est.seconds) +
           ': сверление ' + formatDuration(est.tPlunge + est.dwell + est.peek) +
           ', холостой ход ' + formatDuration(est.tRapid) +
           (est.toolChange > 0 ? ', смена инструмента ' + formatDuration(est.toolChange) : '') + ')');

    return { gcode: g.join('\n'), moves, totalHoles, est };
}

// ============================================================
// 14. ВИЗУАЛИЗАЦИЯ СВЕРЛОВКИ
// ============================================================
function colorForDiameter(d) {
    const hue = 240 - Math.min(240, (Math.log(d + 1) / Math.log(11)) * 240);
    return new THREE.Color('hsl(' + hue + ', 90%, 60%)');
}

function clearDrillPath() {
    while (drillGroup.children.length) {
        const c = drillGroup.children.pop();
        if (c.geometry) c.geometry.dispose();
    }
}

function visualizeHoles(tools, invertY, scale, mirrorX, centerX) {
    clearDrillPath();
    const cx0 = isFinite(centerX) ? centerX : 0;
    tools.forEach(tool => {
        const color = colorForDiameter(tool.d);
        const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
        const r3 = Math.max(0.1, tool.d * 0.15 * scale);
        const geo = new THREE.SphereGeometry(r3, 10, 10);
        tool.holes.forEach(h => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set((mirrorX ? (2 * cx0 - h.cx) : h.cx) * scale, (invertY ? -h.cy : h.cy) * scale, 0);
            m.renderOrder = 999;
            drillGroup.add(m);
        });
    });
}

function visualizeDrillMoves(moves) {
    const rapidPts = [];
    const drillPts = [];
    moves.forEach(m => {
        if (m.type === 'rapid') rapidPts.push(m.x1, m.y1, m.z1, m.x2, m.y2, m.z2);
        else if (m.type === 'drill') drillPts.push(m.x1, m.y1, m.z1, m.x2, m.y2, m.z2);
    });

    if (rapidPts.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(rapidPts, 3));
        const l = new THREE.LineSegments(g, new THREE.LineDashedMaterial({
            color: 0xffaa33, dashSize: 1.5, gapSize: 1.0, opacity: 0.5, transparent: true
        }));
        l.computeLineDistances();
        drillGroup.add(l);
    }
    if (drillPts.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(drillPts, 3));
        drillGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff3355 })));
    }
}

// ============================================================
// 15. ГЕНЕРАЦИЯ СВЕРЛОВКИ
// ============================================================
function generateDrillGCode() {
    if (!window._parsedDXF) { alert('Сначала загрузите DXF.'); return; }

    const minD    = parseFloat(document.getElementById('drill-min-d').value) || 0;
    const maxD    = parseFloat(document.getElementById('drill-max-d').value) || 100;
    const safeZ   = parseFloat(document.getElementById('drill-safe-z').value) || 5;
    const depth   = parseFloat(document.getElementById('drill-depth').value) || -2;
    const pFeed   = parseFloat(document.getElementById('drill-plunge-feed').value) || 100;
    const dwell   = parseFloat(document.getElementById('drill-dwell').value) || 0;
    const mode    = document.getElementById('drill-mode').value;
    const peck    = parseFloat(document.getElementById('drill-peck').value) || 1;
    const invY    = document.getElementById('drill-invert-y').checked;
    const onlyVis = document.getElementById('drill-only-visible').checked;
    const showMk  = document.getElementById('drill-show-marks').checked;
    const mergeD  = document.getElementById('drill-merge-layer-dups').checked;
    const scale   = parseFloat(document.getElementById('cnc-scale').value) || 1;
    const dvSpindle = Math.max(0, domNum('drill-spindle', 1000));
    const dvRapid   = Math.max(1, domNum('drill-rapid-feed', 3000));
    const dvToolChg = Math.max(0, domNum('drill-tool-change', 0));
    const dvMirror  = document.getElementById('drill-mirror-x').checked;
    const boardCX   = window._boardCenterX || 0;

    const infoEl = document.getElementById('drill-info');
    const toolsEl = document.getElementById('drill-tools');

    let holes = extractHoles(window._parsedDXF, onlyVis, mergeD);
    holes = holes.filter(h => h.d >= minD && h.d <= maxD);

    if (holes.length === 0) {
        infoEl.innerText = 'Отверстий в заданном диапазоне не найдено.';
        toolsEl.innerHTML = '';
        document.getElementById('drill-download').disabled = true;
        clearDrillPath();
        return;
    }

    const tools = groupHolesByTool(holes);
    const { gcode, moves, totalHoles, est } = buildDrillGCode(tools, {
        safeZ, depth, plungeFeed: pFeed, dwell, mode, peck, invertY: invY, scale,
        spindle: dvSpindle, rapidFeed: dvRapid, toolChange: dvToolChg,
        mirrorX: dvMirror, centerX: boardCX
    });

    window._lastDrillGCode = gcode;
    document.getElementById('drill-download').disabled = false;

    visualizeHoles(tools, invY, scale, dvMirror, boardCX);
    visualizeDrillMoves(moves);
    drillGroup.visible = showMk;

    const dMin = Math.min(...holes.map(h => h.d)).toFixed(2);
    const dMax = Math.max(...holes.map(h => h.d)).toFixed(2);

    infoEl.innerHTML =
        '✓ Отверстий: ' + totalHoles + ', инструментов: ' + tools.length + '<br>' +
        'Диапазон Ø: ' + dMin + '..' + dMax + ' мм<br>' +
        'Безопасная Z: ' + safeZ + ', Z сверления: ' + depth + '<br>' +
        'Режим: ' + (mode === 'peck' ? 'Peck ' + peck + ' мм' : 'Простое') +
        ', пауза: ' + dwell + ' сек<br>' +
        'Врезание: ' + pFeed.toFixed(0) + ' мм/мин | S' + dvSpindle.toFixed(0) + ' об/мин<br>' +
        'Холостой ход: ' + est.rapidLen.toFixed(1) + ' мм, сверление: ' + est.plungeLen.toFixed(1) + ' мм<br>' +
        '<b>Оценка времени: ~' + formatDuration(est.seconds) + '</b>' +
        ' (сверление ' + formatDuration(est.tPlunge + est.dwell + est.peek) +
        ', холостой ' + formatDuration(est.tRapid) +
        (est.toolChange > 0 ? ', смена инстр. ' + formatDuration(est.toolChange) : '') + ')<br>' +
        (dvMirror ? 'Зеркало по X: вкл (центр X = ' + boardCX.toFixed(3) + ' ед.)<br>' : '');

    toolsEl.innerHTML = tools.map((t, i) =>
        '<div class="drill-tool-item">' +
            '<span>T' + (i+1) + '  Ø' + t.d.toFixed(2) + ' мм</span>' +
            '<span style="color:#ffa94d;">' + t.holes.length + ' отв.</span>' +
        '</div>'
    ).join('');
}

// ============================================================
// 15b. ЛАЗЕР: КОНТУРНЫЙ G-CODE (формат проекта gcodeide)
// ============================================================
// Файл повторяет вывод gcodeide один в один:
//     G90
//     G21
//     M4 S0
//     (для каждого контура каждого слоя; S/F — настройки слоя)
//     G0 X… Y…     — холостой ход в начало контура
//     F…           — рабочая подача слоя
//     S…           — мощность лазера слоя
//     G1 X… Y…     — обход контура (на каждую точку — своя строка)
//     S0           — лазер выключен
//     M5 S0
// Геометрия берётся «как нарисовано» в DXF: центральные линии дорожек,
// контуры площадок, круги, дуги, петли HATCH. Оффсеты и объединение
// (как во фрезеровке) здесь не применяются.

const LASER_DEFAULTS = { power: 730, speed: 300, repeat: 1 };

// Округление координат (gcodeide пишет координаты с 2 знаками)
function laserRound(v, decimals) {
    const k = Math.pow(10, decimals);
    return Math.round(v * k) / k;
}

// Числа в F/S пишем без лишних нулей: 1000 -> "1000", 12.5 -> "12.5"
function laserNum(v) {
    return String(laserRound(v, 2));
}

// Все контуры DXF «как нарисовано», БЕЗ буферизации и объединения.
// isVisible(name) — фильтр слоёв, segLen — макс. длина сегмента дуги (мм).
function collectLaserPaths(parsed, isVisible, segLen) {
    const out = [];
    const step = (isFinite(segLen) && segLen > 0.01) ? segLen : 0.5;

    parsed.entities.forEach(ent => {
        const layer = ent.layer || '0';
        if (!isVisible(layer)) return;

        if (ent.type === 'HATCH') {
            (ent.loops || []).forEach(loop => {
                if (!loop || loop.length < 2) return;
                const pts = cleanLoop(expandPolyline(loop, true, step), true);
                if (pts.length >= 3) out.push({ layer, pts, closed: true });
            });
            return;
        }

        if (ent.type === 'CIRCLE') {
            if (ent.r > 0 && isFinite(ent.cx) && isFinite(ent.cy)) {
                out.push({ layer, pts: circleToPolygon(ent.cx, ent.cy, ent.r, 48), closed: true });
            }
            return;
        }

        if (ent.type === 'ARC') {
            if (ent.r > 0 && isFinite(ent.cx) && isFinite(ent.cy)) {
                let sweep = ent.endAngle - ent.startAngle;
                while (sweep < 0) sweep += 360;
                const arcLen = Math.abs(ent.r * sweep * Math.PI / 180);
                const segs = Math.min(2048, Math.max(4, Math.ceil(arcLen / step)));
                const pts = arcToPoints(ent.cx, ent.cy, ent.r, ent.startAngle, ent.endAngle, segs);
                if (pts.length >= 2) out.push({ layer, pts, closed: false });
            }
            return;
        }

        if (ent.type === 'LINE') {
            if (ent.p1 && ent.p2) {
                out.push({ layer, pts: [{ x: ent.p1.x, y: ent.p1.y }, { x: ent.p2.x, y: ent.p2.y }], closed: false });
            }
            return;
        }

        if (ent.type === 'LWPOLYLINE' && ent.points && ent.points.length > 1) {
            const ps = ent.points;
            const n = ps.length;

            // 2 точки с bulge ≈ ±1 — это окружность (как в отрисовке и фрезеровке)
            if (n === 2 && Math.abs(ps[0].bulge || 0) > 0.99 && Math.abs(ps[1].bulge || 0) > 0.99) {
                const cx = (ps[0].x + ps[1].x) / 2, cy = (ps[0].y + ps[1].y) / 2;
                const r = Math.hypot(ps[1].x - ps[0].x, ps[1].y - ps[0].y) / 2;
                if (r > 0) out.push({ layer, pts: circleToPolygon(cx, cy, r, 48), closed: true });
                return;
            }

            const closed = ent.isClosed ||
                (n > 2 && Math.hypot(ps[0].x - ps[n - 1].x, ps[0].y - ps[n - 1].y) < 1e-4);
            const pts = cleanLoop(expandPolyline(ps, closed, step), closed);
            if (closed && pts.length >= 3) out.push({ layer, pts, closed: true });
            else if (!closed && pts.length >= 2) out.push({ layer, pts, closed: false });
        }
    });

    return out;
}

// G-code по контурам. layers = [{ name, paths: [{ pts, closed }], power, speed, repeat }]
// Возвращает { gcode, moves, stats }. Формат строк — как в gcodeide.
function buildLaserGCode(layers, opts) {
    const o = opts || {};
    const dec = Math.max(0, Math.min(4, Math.round(isFinite(o.decimals) ? o.decimals : 2)));
    const comments = !!o.comments;
    const rapidFeed = (isFinite(o.rapidFeed) && o.rapidFeed > 0) ? o.rapidFeed : 3000;
    const fmt = v => laserRound(v, dec).toFixed(dec);

    const g = [];
    const moves = [];
    let contourCount = 0, layerCount = 0;
    let cutLen = 0, rapidLen = 0, tCut = 0, tRapid = 0;
    let cur = { x: 0, y: 0 };

    g.push('G90');
    g.push('G21');
    g.push('M4 S0');

    layers.forEach(layer => {
        const paths = (layer.paths || []).filter(p => p && p.pts && p.pts.length >= 2);
        if (!paths.length) return;

        const power  = Math.max(0, Number(laserNum(layer.power)));
        const speed  = Math.max(1, Number(laserNum(layer.speed)));
        const repeat = Math.max(1, Math.round(layer.repeat) || 1);
        layerCount++;

        if (comments) {
            g.push('(Слой ' + layer.name + ': S' + power + ' F' + speed +
                   ', контуров ' + paths.length + ', повторов ' + repeat + ')');
        }

        for (let r = 0; r < repeat; r++) {
            paths.forEach(path => {
                const pts = path.closed ? path.pts.concat([path.pts[0]]) : path.pts;
                const p0 = pts[0];

                g.push('G0 X' + fmt(p0.x) + ' Y' + fmt(p0.y));
                g.push('F' + speed);
                g.push('S' + power);

                const dR = Math.hypot(p0.x - cur.x, p0.y - cur.y);
                rapidLen += dR;
                tRapid += dR / rapidFeed * 60;
                moves.push({ type: 'rapid', x1: cur.x, y1: cur.y, z1: 0, x2: p0.x, y2: p0.y, z2: 0 });

                let prev = p0;
                for (let i = 1; i < pts.length; i++) {
                    const p = pts[i];
                    g.push('G1 X' + fmt(p.x) + ' Y' + fmt(p.y));
                    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
                    cutLen += d;
                    tCut += d / speed * 60;
                    moves.push({ type: 'cut', x1: prev.x, y1: prev.y, z1: 0, x2: p.x, y2: p.y, z2: 0 });
                    prev = p;
                }

                g.push('S0');
                cur = prev;
                contourCount++;
            });
        }
    });

    g.push('M5 S0');

    return {
        gcode: g.join('\n'),
        moves,
        stats: {
            contourCount, layerCount,
            gcodeLines: g.length,
            cutLen, rapidLen, totalLen: cutLen + rapidLen,
            tCut, tRapid, seconds: tCut + tRapid
        }
    };
}

// --- порядок обходов: ближайший контур по bbox-центру; для замкнутых
// контуров вход — с ближайшей к текущей позиции вершины (экономия G0) ---
function laserRotateClosedPath(pts, x, y) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - x, pts[i].y - y);
        if (d < bd) { bd = d; bi = i; }
    }
    return bi === 0 ? pts : pts.slice(bi).concat(pts.slice(0, bi));
}

function orderLaserItems(items, startX, startY, rotate) {
    const rest = items.slice();
    const ordered = [];
    let cx = startX, cy = startY;

    while (rest.length) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < rest.length; i++) {
            const c = chainCenter(rest[i].pts);
            const d = Math.hypot(c.cx - cx, c.cy - cy);
            if (d < bd) { bd = d; bi = i; }
        }
        const it = rest.splice(bi, 1)[0];
        const pts = (rotate && it.closed) ? laserRotateClosedPath(it.pts, cx, cy) : it.pts;
        ordered.push({ layer: it.layer, closed: it.closed, pts });
        const last = pts[pts.length - 1];
        cx = last.x;
        cy = last.y;
    }
    return ordered;
}

// --- визуализация лазерного пути (Z = 0, лазер не меняет высоту) ---
const laserMaterials = {
    rapid: new THREE.LineDashedMaterial({ color: 0xffcc00, dashSize: 1.5, gapSize: 1.0, transparent: true, opacity: 0.5 }),
    cut: new THREE.LineBasicMaterial({ color: 0xff5566 })
};

function clearLaserPath() {
    while (laserGroup.children.length) {
        const c = laserGroup.children.pop();
        if (c.geometry) c.geometry.dispose();
    }
}

function visualizeLaserPath(moves) {
    clearLaserPath();
    const rapid = [], cut = [];
    moves.forEach(m => {
        if (m.type === 'rapid') rapid.push(m.x1, m.y1, m.z1, m.x2, m.y2, m.z2);
        else cut.push(m.x1, m.y1, m.z1, m.x2, m.y2, m.z2);
    });

    if (rapid.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(rapid, 3));
        const l = new THREE.LineSegments(g, laserMaterials.rapid);
        l.computeLineDistances();
        laserGroup.add(l);
    }
    if (cut.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(cut, 3));
        laserGroup.add(new THREE.LineSegments(g, laserMaterials.cut));
    }
    laserGroup.visible = domChk('laser-show-path', true);
}

// --- таблица слоёв лазера: галочка + S (мощность) + F (скорость) + повторы ---
function laserNumInput(cls, val, tip) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = cls;
    inp.value = val;
    inp.min = '0';
    inp.step = '1';
    inp.title = tip;
    return inp;
}

function buildLaserLayerRows() {
    const host = document.getElementById('laser-layers');
    if (!host) return;
    host.innerHTML = '';

    const names = Object.keys(layerGroups).sort();
    if (names.length === 0) {
        const d = document.createElement('div');
        d.style.cssText = 'font-size: 12px; color: #777;';
        d.innerText = 'Загрузите DXF файл...';
        host.appendChild(d);
        return;
    }

    names.forEach(name => {
        const row = document.createElement('div');
        row.className = 'laser-layer-row';
        row.dataset.layer = name;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.title = 'Гравировать этот слой';

        const badge = document.createElement('span');
        badge.className = 'layer-color-badge';
        badge.style.backgroundColor = '#' + ((layerColors[name] || 0x999999) >>> 0).toString(16).padStart(6, '0');

        const lbl = document.createElement('span');
        lbl.className = 'name';
        lbl.innerText = name;
        lbl.title = name;

        row.append(cb, badge, lbl,
            laserNumInput('laser-power', LASER_DEFAULTS.power, 'S — мощность лазера'),
            laserNumInput('laser-speed', LASER_DEFAULTS.speed, 'F — скорость, мм/мин'),
            laserNumInput('laser-repeat', LASER_DEFAULTS.repeat, 'Число повторов этого слоя'));

        host.appendChild(row);
    });
}

function readLaserLayerConfig() {
    const cfg = {};
    const host = document.getElementById('laser-layers');
    if (!host) return cfg;

    host.querySelectorAll('.laser-layer-row').forEach(row => {
        const name = row.dataset.layer;
        if (!name) return;
        const cb = row.querySelector('input[type="checkbox"]');
        const pw = row.querySelector('.laser-power');
        const sp = row.querySelector('.laser-speed');
        const rp = row.querySelector('.laser-repeat');
        cfg[name] = {
            on:     cb ? cb.checked : false,
            power:  Math.max(0, parseFloat(pw ? pw.value : '') || 0),
            speed:  Math.max(1, parseFloat(sp ? sp.value : '') || 1),
            repeat: Math.max(1, parseInt(rp ? rp.value : '', 10) || 1)
        };
    });
    return cfg;
}

// Генерация лазерного G-code из интерфейса (кнопка «Сгенерировать лазерный G-code»)
function generateLaserGCode() {
    if (!window._parsedDXF) { alert('Сначала загрузите DXF файл.'); return; }

    const scale     = domNum('laser-scale', 1) || 1;
    const segLen    = Math.max(0.05, domNum('laser-seg-len', 0.5));
    const decimals  = Math.max(0, Math.min(4, Math.round(domNum('laser-decimals', 2))));
    const invertY   = domChk('laser-invert-y', false);
    const mirrorX   = domChk('laser-mirror-x', false);
    const onlyVis   = domChk('laser-only-visible', false);
    const optimize  = domChk('laser-optimize', true);
    const comments  = domChk('laser-comments', false);
    const rapidFeed = Math.max(1, domNum('cnc-rapid-feed', 3000));   // только для оценки времени

    // Режим гравировки: контуры «как нарисовано» либо заливка пустот
    // (как «zapolnit dlya lazera krasivo» / «zapolnit dlya lazera» в gcodeide).
    const mode = laserFillMode();
    const fillOpt = {
        offX:   Math.max(0, domNum('laser-fill-off-x', LASER_FILL_DEFAULTS.offX)),
        offY:   Math.max(0, domNum('laser-fill-off-y', LASER_FILL_DEFAULTS.offY)),
        stepX:  Math.max(0.01, domNum('laser-fill-step-x', LASER_FILL_DEFAULTS.stepX)),
        stepY:  Math.max(0.01, domNum('laser-fill-step-y', LASER_FILL_DEFAULTS.stepY)),
        passes: Math.max(1, Math.round(domNum('laser-fill-passes', LASER_FILL_DEFAULTS.passes))),
        clip:   domChk('laser-fill-clip', true)
    };
    const isFill = (mode === 'fill-rings' || mode === 'fill-hatch');

    const info = document.getElementById('laser-info');
    const loadingEl = document.getElementById('loading');

    const cfg = readLaserLayerConfig();
    const enabled = Object.keys(cfg).filter(n => cfg[n].on);
    if (enabled.length === 0) { alert('В таблице слоёв лазера не выбрано ни одного слоя.'); return; }

    loadingEl.style.display = 'block';
    info.innerText = isFill ? 'Построение заливки пустот (медь объединяется)...'
                            : 'Построение контуров для лазера...';

    setTimeout(() => {
        try {
            const t0 = performance.now();

            const isVisible = name => !!(cfg[name] && cfg[name].on) &&
                (!onlyVis || !layerGroups[name] || layerGroups[name].visible);

            // единицы DXF -> мм, инверсия Y, зеркало относительно центра платы
            const centerMm = (window._boardCenterX || 0) * scale;
            const layers = [];
            let fillStats = null;

            if (!isFill) {
                const raw = collectLaserPaths(window._parsedDXF, isVisible, segLen);
                if (raw.length === 0) {
                    loadingEl.style.display = 'none';
                    info.innerHTML = 'Контуров не найдено. Проверьте галочки в таблице слоёв' +
                        (onlyVis ? ' и снимите «Только видимые слои»' : '') + '.';
                    clearLaserPath();
                    document.getElementById('laser-download').disabled = true;
                    return;
                }

                const items = raw.map(it => {
                    let pts = it.pts.map(p => ({ x: p.x * scale, y: (invertY ? -p.y : p.y) * scale }));
                    if (mirrorX) pts = mirrorPointsX(pts, centerMm);
                    return { layer: it.layer, closed: it.closed, pts };
                }).filter(it => it.pts.length >= 2);

                // группировка по слоям, внутри слоя — порядок nearest-neighbor
                let cx = 0, cy = 0;
                enabled.forEach(name => {
                    let list = items.filter(it => it.layer === name);
                    if (list.length === 0) return;
                    if (optimize) list = orderLaserItems(list, cx, cy, true);
                    const last = list[list.length - 1].pts;
                    cx = last[last.length - 1].x;
                    cy = last[last.length - 1].y;
                    layers.push({
                        name,
                        paths: list.map(it => ({ pts: it.pts, closed: it.closed })),
                        power:  cfg[name].power,
                        speed:  cfg[name].speed,
                        repeat: cfg[name].repeat
                    });
                });
            } else {
                // Заливка пустот: медь собирается объединённо по всем отмеченным
                // слоям (как в gcodeide), S/F/повторы — из первого отмеченного.
                const lineW = Math.max(0.01, domNum('cnc-line-width', 0.1));
                const fill = buildLaserFillPaths(window._parsedDXF, isVisible, mode, scale,
                                                 lineW, invertY, mirrorX, centerMm, fillOpt);
                if (fill.paths.length === 0) {
                    loadingEl.style.display = 'none';
                    info.innerHTML = 'Заливка не построена: медь не найдена' +
                        (onlyVis ? ' (возможно, слои скрыты — снимите «Только видимые слои»)' : '') +
                        ' или пустоты уже заполнены за заданное число контуров.';
                    clearLaserPath();
                    document.getElementById('laser-download').disabled = true;
                    return;
                }

                const first = enabled[0];
                let list = fill.paths.map(p => ({ layer: first, closed: p.closed, pts: p.pts }));
                if (optimize) list = orderLaserItems(list, 0, 0, false);
                layers.push({
                    name: first + ' · заливка',
                    paths: list.map(it => ({ pts: it.pts, closed: it.closed })),
                    power:  cfg[first].power,
                    speed:  cfg[first].speed,
                    repeat: cfg[first].repeat
                });

                fillStats = {
                    copper: fill.copperCount,
                    board: fill.board,
                    mode
                };
            }

            const { gcode, moves, stats } = buildLaserGCode(layers, { decimals, comments, rapidFeed });
            const dt = performance.now() - t0;

            window._lastLaserGCode = gcode;
            document.getElementById('laser-download').disabled = false;
            visualizeLaserPath(moves);

            // Разложение отступа на «номинал (Y) + анизотропия X» — как в gcodeide
            const offNom = fillOpt.offY, offAniso = fillOpt.offX - fillOpt.offY;
            const fillLine = fillStats
                ? 'Заливка (' + (fillStats.mode === 'fill-hatch' ? 'штриховка' : 'кольца') +
                  '): отступ от дорожек X/Y ' + fillOpt.offX.toFixed(3) + '/' + fillOpt.offY.toFixed(3) +
                  ' мм (номинал ' + offNom.toFixed(3) + ' + анизотропия X ' +
                  (offAniso >= 0 ? '+' : '') + offAniso.toFixed(3) + ')' +
                  ', шаг X/Y ' + fillOpt.stepX.toFixed(3) + '/' + fillOpt.stepY.toFixed(3) +
                  ' мм, контуров ' + fillOpt.passes +
                  (fillOpt.clip ? ', обрезка по рамке платы' : '') + ';<br>' +
                  'рамка платы X ' + fillStats.board.minX.toFixed(2) + '…' + fillStats.board.maxX.toFixed(2) +
                  ', Y ' + fillStats.board.minY.toFixed(2) + '…' + fillStats.board.maxY.toFixed(2) + ' мм<br>'
                : '';

            info.innerHTML =
                '✓ ' + (fillStats ? 'Заливка: путей ' + stats.contourCount
                                  : 'Контуров: ' + stats.contourCount) +
                ', слоёв: ' + stats.layerCount +
                ', строк: ' + stats.gcodeLines + ' (' + dt.toFixed(0) + ' мс)<br>' +
                'Гравировка: ' + stats.cutLen.toFixed(1) + ' мм | холостой ход: ' +
                stats.rapidLen.toFixed(1) + ' мм<br>' +
                '<b>Оценка времени: ~' + formatDuration(stats.seconds) + '</b>' +
                ' (лазер ' + formatDuration(stats.tCut) + ', G0 ' + formatDuration(stats.tRapid) +
                ' при ' + rapidFeed.toFixed(0) + ' мм/мин)<br>' +
                fillLine +
                'Координаты: ' + decimals + ' знак(ов)' +
                (invertY ? ', Y инвертирован' : '') + (mirrorX ? ', зеркало по X' : '') +
                (comments ? ', с комментариями' : '') + '<br>' +
                'Порядок обходов: ' + (optimize ? 'nearest-neighbor' : 'как в DXF');

            loadingEl.style.display = 'none';
        } catch (err) {
            console.error(err);
            loadingEl.style.display = 'none';
            info.innerText = 'Ошибка: ' + err.message;
            alert('Ошибка: ' + err.message);
        }
    }, 50);
}

// ============================================================
// 15c. ЛАЗЕР: ЗАЛИВКА ПУСТОТ (как «zapolnit dlya lazera krasivo»)
// ============================================================
// В старом проекте (gcodeide) лазерная заливка делалась так:
//   * kam3_callback («zapolnit dlya lazera krasivo»): контуры меди
//     объединялись, внутренние контуры вычитались, а затем Polygon_to_lines2()
//     выводил контур области и «раздувал» её на ширину линии — так num_lines
//     раз (10 по умолчанию). Получались вложенные кольца, идущие от меди в
//     пустоты; пути обрезались рамкой платы (BORDER).
//   * kam_callback («zapolnit dlya lazera»): горизонтальные линии через всю
//     плату с шагом border_line_width, из которых вычиталась медь.
// Отличие здесь одно: пятно лазера овальное, поэтому и отступ от дорожек,
// и шаг между кольцами задаются отдельно по X и по Y. Оффсет считается в
// растянутых координатах (x/dx, y/dy): обычный круглый оффсет Clipper в таком
// пространстве даёт эллипс с полуосями dx (по X) и dy (по Y).

// Значения по умолчанию — «как в gcodeide» (пресет «Altium заливка»):
// offX = номинал + анизотропия = 0.09 + 0.035 = 0.125, offY = номинал = 0.09.
const LASER_FILL_DEFAULTS = {
    offX: 0.125, offY: 0.09, nom: 0.09, aniso: 0.035,
    stepX: 0.1, stepY: 0.1, passes: 10
};

// --- Овальное пятно лазера «как в gcodeide»: номинал зазора + анизотропия -----
// В старом проекте (GUI.py, импортёры DXF) зазор на сторону считался как
//     for_bufferX + (get_radius(направление) − b) / 2,
// где get_radius() (GUI.py:442-451) жёстко берёт a = 0.11 (полуось по X) и
// b = 0.04 (полуось по Y) и смешивает полярный радиус эллипса с a на 50 %:
//   * горизонтальный сегмент дорожки -> зазор по Y = for_bufferX (номинал),
//   * вертикальный сегмент дорожки   -> зазор по X = for_bufferX + (a − b)/2.
// Отсюда и разложение: offY = номинал, offX = номинал + анизотропия, где
// анизотропия = (a − b)/2 = 0.035 мм на сторону.
const GCODEIDE_SPOT = { a: 0.11, b: 0.04 };
const GCODEIDE_ANISO_X = (GCODEIDE_SPOT.a - GCODEIDE_SPOT.b) / 2;   // 0.035 мм/сторону

// Номиналы из импортёров gcodeide: for_buffer — заливка лазером (тег for_zapolnit),
// for_buffer2 — обводка дорожек.
const GCODEIDE_FILL_PRESETS = {
    'altium-fill':    { nom: 0.09, aniso: GCODEIDE_ANISO_X },   // read_dxf_lines_from_altium: for_buffer  = 0.09
    'altium-scale':   { nom: 0.07, aniso: GCODEIDE_ANISO_X },   //   он же:                     for_buffer2 = 0.07
    'esyeda-fill':    { nom: 0.08, aniso: GCODEIDE_ANISO_X },   // read_dxf_lines_from_esyeda: for_buffer  = 0.08
    'esyedapro-fill': { nom: 0.11, aniso: GCODEIDE_ANISO_X }    // read_dxf_lines_from_esyedapro: for_buffer = 0.11
};
const LASER_FILL_PRESET_DEFAULT = 'altium-fill';

// Отступы овального пятна из пары «номинал (Y) / анизотропия X» (gcodeide-совместимо).
// Пустые/нечисловые аргументы заменяются значениями по умолчанию.
function gcodeideAnisoOffsets(nomMm, anisoMm) {
    const num = (v, def) => {
        if (v === undefined || v === null || v === '') return def;
        const n = Number(v);
        return isFinite(n) ? n : def;
    };
    const nom = Math.max(0, num(nomMm, LASER_FILL_DEFAULTS.nom));
    const aniso = num(anisoMm, GCODEIDE_ANISO_X);
    return { offX: nom + aniso, offY: nom, nom: nom, aniso: aniso };
}

const LASER_FILL_ANISO_SCALE = 1000;  // 1 единица растянутого пространства ≈ dx/1000 мм
const LASER_FILL_ARC_MM = 0.005;      // допуск аппроксимации дуг/углов, мм
const LASER_FILL_CLEAN_MM = 0.002;    // прореживание совпадающих точек, мм

// Оффсет «наружу» с разными величинами по X и Y (овальный луч лазера).
// dxMm/dyMm — в мм; берутся по модулю: заливка всегда идёт от меди в пустоты.
// 0 читается как минимальная дельта 0.0001 мм — тогда первое кольцо идёт точно
// по границе меди, как в Polygon_to_lines2() старого проекта (k = 0).
function clipperOffsetAniso(polygons, dxMm, dyMm) {
    if (!CLIPPER || !polygons || polygons.length === 0) return [];
    // вход должен быть «чистым» набором контуров (union): ClipperOffset работает
    // по ориентации пути, а у сырых полигонов (буферы линий, заливки HATCH) она
    // произвольна и они пересекаются между собой.
    const dx = Math.max(1e-4, Math.abs(dxMm));
    const dy = Math.max(1e-4, Math.abs(dyMm));
    const kx = LASER_FILL_ANISO_SCALE / dx;
    const ky = LASER_FILL_ANISO_SCALE / dy;

    const paths = [];
    polygons.forEach(poly => {
        if (!poly || poly.length < 3) return;
        paths.push(poly.map(q => ({ X: Math.round(q.x * kx), Y: Math.round(q.y * ky) })));
    });
    if (!paths.length) return [];

    const arcTol = Math.max(1, Math.round(LASER_FILL_ARC_MM * (kx + ky) / 2));
    const off = new CLIPPER.ClipperOffset(2.0, arcTol);
    off.AddPaths(paths, CLIPPER.JoinType.jtRound, CLIPPER.EndType.etClosedPolygon);
    const sol = new CLIPPER.Paths();
    // дельта ровно в одну «единицу» = +dx мм по X и +dy мм по Y
    off.Execute(sol, LASER_FILL_ANISO_SCALE);

    const cleanTol = Math.max(1, Math.round(LASER_FILL_CLEAN_MM * Math.min(kx, ky)));
    const cleaned = CLIPPER.Clipper.CleanPolygons(sol, cleanTol);
    return cleaned
        .map(path => path.map(q => ({ x: q.X / kx, y: q.Y / ky })))
        .filter(poly => poly.length >= 3);
}

// --- обрезка путей рамкой платы (аналог shapely.intersection(..., BORDER)) ---
function clipSegToRect(a, b, r) {
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    const lim = [
        [-dx, a.x - r.minX], [dx, r.maxX - a.x],
        [-dy, a.y - r.minY], [dy, r.maxY - a.y]
    ];
    for (let i = 0; i < 4; i++) {
        const p = lim[i][0], q = lim[i][1];
        if (Math.abs(p) < 1e-15) { if (q < 0) return null; continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
        else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return [{ x: a.x + t0 * dx, y: a.y + t0 * dy },
            { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}

// Полилиния, обрезанная прямоугольником: список непрерывных кусков.
function clipPolylineToRect(pts, r) {
    const out = [];
    let run = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const seg = clipSegToRect(pts[i], pts[i + 1], r);
        if (!seg) {
            if (run.length > 1) out.push(run);
            run = [];
            continue;
        }
        if (!run.length) {
            run.push(seg[0]);
        } else {
            const last = run[run.length - 1];
            if (Math.hypot(last.x - seg[0].x, last.y - seg[0].y) > 1e-9) {
                if (run.length > 1) out.push(run);
                run = [seg[0]];
            }
        }
        run.push(seg[1]);
    }
    if (run.length > 1) out.push(run);
    return out;
}

// Интервалы пустоты на горизонтали y: пересечения с контурами меди берутся по
// правилу чётности (работает и с отверстиями).
function scanlineVoidSpans(polys, y, minX, maxX) {
    const xs = [];
    for (let pi = 0; pi < polys.length; pi++) {
        const poly = polys[pi];
        if (!poly || poly.length < 3) continue;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            if ((a.y > y) === (b.y > y)) continue;
            const t = (y - a.y) / (b.y - a.y);
            xs.push(a.x + t * (b.x - a.x));
        }
    }
    if (!xs.length) return [{ x0: minX, x1: maxX }];
    xs.sort((p, q) => p - q);

    // Чётные пары пересечений — «медь». Рамку платы отсекаем уже от готовых
    // интервалов пустоты: если выбрасывать пересечения за рамкой до разбиения
    // на пары, чётность поедет и в штриховке появятся линии внутри меди
    // (на реальной плате так выходило на рамке платы, выходящей за габарит).
    const out = [];
    let cur = minX;
    for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.min(xs[i], maxX);
        const x1 = Math.min(xs[i + 1], maxX);
        if (x1 <= cur) continue;          // эта медь целиком левее текущей позиции
        if (x0 >= maxX) break;            // дальше только за рамкой
        if (x0 > cur) out.push({ x0: cur, x1: x0 });
        cur = x1;
    }
    if (cur < maxX) out.push({ x0: cur, x1: maxX });
    return out.filter(s => s.x1 - s.x0 > 1e-6);
}

// Кольца от меди в пустоты (kam3_callback + Polygon_to_lines2):
// контур меди -> +отступ -> контур -> +шаг -> ... пока не исчерпаны контуры.
function buildLaserRings(copperMm, board, opt) {
    const paths = [];
    const copper = clipperUnion(copperMm);
    if (!copper.length) return paths;

    let ring = clipperOffsetAniso(copper, opt.offX, opt.offY);
    const passes = Math.max(1, Math.round(opt.passes));

    for (let k = 0; k < passes && ring.length; k++) {
        ring.forEach(poly => {
            if (!poly || poly.length < 3) return;
            if (isDegenerateContour(poly)) return;   // мусор от целочисленного оффсета
            if (!opt.clip) { paths.push({ pts: poly, closed: true }); return; }
            const closed = poly.concat([poly[0]]);
            clipPolylineToRect(closed, board).forEach(seg => {
                if (seg.length >= 2 && contourDiag(seg) >= MIN_CUT_DIAG_MM) {
                    paths.push({ pts: seg, closed: false });
                }
            });
        });
        ring = clipperOffsetAniso(ring, opt.stepX, opt.stepY);
    }
    return paths;
}

// Штриховка пустот (kam_callback): горизонтальные линии через всю плату с
// шагом по Y минус медь (с отступом X/Y — овальный луч).
function buildLaserHatch(copperMm, board, opt) {
    const paths = [];
    // отступ считаем от union-меди: у сырых полигонов ориентация произвольна
    // (буферы линий, заливки HATCH), и ClipperOffset даёт по ним не тот контур,
    // что union — тогда штриховка залезает в медь.
    const copper = clipperUnion(copperMm);
    const grown = clipperOffsetAniso(copper, opt.offX, opt.offY);
    const step = Math.max(0.01, opt.stepY);
    let k = 0;
    for (let y = board.minY; y <= board.maxY + 1e-9 && k < 100000; y += step, k++) {
        scanlineVoidSpans(grown, y, board.minX, board.maxX).forEach(s => {
            // штрих короче MIN_CUT_DIAG_MM — точка прожига, а не линия
            if (s.x1 - s.x0 < MIN_CUT_DIAG_MM) return;
            paths.push({ pts: [{ x: s.x0, y }, { x: s.x1, y }], closed: false });
        });
    }
    return paths;
}

// Полигоны DXF -> полигоны в мм (то же преобразование, что и для контуров)
function laserPolysToMm(polys, scale, invertY, mirrorX, centerMm) {
    const out = [];
    polys.forEach(poly => {
        let pts = poly.map(p => ({ x: p.x * scale, y: (invertY ? -p.y : p.y) * scale }));
        if (mirrorX) pts = mirrorPointsX(pts, centerMm);
        if (pts.length >= 3) out.push(pts);
    });
    return out;
}

// Габарит всей геометрии DXF в единицах DXF — рамка платы для обрезки заливки
function dxfBoundsAll(parsed) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const acc = (x, y) => {
        if (!isFinite(x) || !isFinite(y)) return;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    };
    (parsed.entities || []).forEach(ent => {
        if (ent.type === 'LINE') {
            if (ent.p1) acc(ent.p1.x, ent.p1.y);
            if (ent.p2) acc(ent.p2.x, ent.p2.y);
        } else if (ent.type === 'CIRCLE' || ent.type === 'ARC') {
            if (ent.r > 0) { acc(ent.cx - ent.r, ent.cy - ent.r); acc(ent.cx + ent.r, ent.cy + ent.r); }
        } else if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
            (ent.points || []).forEach(p => acc(p.x, p.y));
        } else if (ent.type === 'HATCH') {
            (ent.loops || []).forEach(l => (l || []).forEach(p => acc(p.x, p.y)));
        }
    });
    return { minX, minY, maxX, maxY };
}

// Рамка платы в мм с учётом масштаба, инверсии Y и зеркала по X
function laserBoardMm(parsed, scale, invertY, mirrorX, centerMm) {
    const b = dxfBoundsAll(parsed);
    if (!isFinite(b.minX) || !isFinite(b.maxX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let x1 = b.minX * scale, x2 = b.maxX * scale;
    const y1 = (invertY ? -b.maxY : b.minY) * scale;
    const y2 = (invertY ? -b.minY : b.maxY) * scale;
    if (mirrorX) {
        const a = 2 * centerMm - x1, c = 2 * centerMm - x2;
        x1 = Math.min(a, c); x2 = Math.max(a, c);
    }
    return { minX: Math.min(x1, x2), maxX: Math.max(x1, x2),
             minY: Math.min(y1, y2), maxY: Math.max(y1, y2) };
}

// Текущий режим лазера из селекта (по умолчанию — контуры «как нарисовано»)
function laserFillMode() {
    const el = document.getElementById('laser-mode');
    return (el && el.value) ? el.value : 'contour';
}

// Число в строку для поля ввода без «0.10500000000000001»
function fmtMm(v) { return String(Math.round(v * 1e4) / 1e4); }

// Параметры пятна из полей «номинал/анизотропия» (пресет — только значения по умолчанию)
function laserSpotParams() {
    const sel = document.getElementById('laser-fill-preset');
    const preset = GCODEIDE_FILL_PRESETS[(sel && sel.value) || LASER_FILL_PRESET_DEFAULT];
    const nom = domNum('laser-fill-nom', preset ? preset.nom : LASER_FILL_DEFAULTS.nom);
    const aniso = domNum('laser-fill-aniso', preset ? preset.aniso : GCODEIDE_ANISO_X);
    return gcodeideAnisoOffsets(nom, aniso);
}

// Пересчёт отступов X/Y из «номинал + анизотропия» (X = номинал + анизотропия, Y = номинал)
function syncLaserFillOffsets() {
    const p = laserSpotParams();
    const ex = document.getElementById('laser-fill-off-x');
    const ey = document.getElementById('laser-fill-off-y');
    if (ex) ex.value = fmtMm(p.offX);
    if (ey) ey.value = fmtMm(p.offY);
    return p;
}

// Выбор пресета gcodeide: подставляем номинал/анизотропию и пересчитываем отступы X/Y
function applyLaserFillPreset() {
    const sel = document.getElementById('laser-fill-preset');
    const preset = GCODEIDE_FILL_PRESETS[(sel && sel.value) || ''];
    if (preset) {
        const n = document.getElementById('laser-fill-nom');
        const a = document.getElementById('laser-fill-aniso');
        if (n) n.value = fmtMm(preset.nom);
        if (a) a.value = fmtMm(preset.aniso);
    }
    return syncLaserFillOffsets();
}

// Заливка пустот: медь по всем отмеченным слоям -> кольца (krasivo) или штриховка
function buildLaserFillPaths(parsed, isVisible, mode, scale, lineWidth, invertY, mirrorX, centerMm, opt) {
    const copperDxf = collectMillingPolygons(parsed, isVisible, lineWidth);
    const copperMm = laserPolysToMm(copperDxf, scale, invertY, mirrorX, centerMm);
    const board = laserBoardMm(parsed, scale, invertY, mirrorX, centerMm);
    let paths = [];
    if (copperMm.length) {
        paths = (mode === 'fill-hatch')
            ? buildLaserHatch(copperMm, board, opt)
            : buildLaserRings(copperMm, board, opt);
    }
    return { paths, board, copperMm, copperCount: copperDxf.length };
}

// ============================================================
// 16. HANDLERS
// ============================================================
const parser = new DXFParser();

function loadDXFText(text) {
    document.getElementById('loading').style.display = 'block';
    document.getElementById('error-log').style.display = 'none';
    setTimeout(() => {
        try {
            const parsed = parser.parse(text);
            window._parsedDXF = parsed;
            window._boardCenterX = getBoardCenterX(parsed);
            window._pathCameraSet = false;
            build3DScene(parsed);
            clearToolpath();
            clearDrillPath();
            clearMeasure();
            clearDRC();
            document.getElementById('cnc-download').disabled = true;
            document.getElementById('cnc-info').innerText = '';
            document.getElementById('drill-download').disabled = true;
            document.getElementById('drill-info').innerText = '';
            document.getElementById('drill-tools').innerHTML = '';
            clearLaserPath();
            buildLaserLayerRows();
            document.getElementById('laser-download').disabled = true;
            document.getElementById('laser-info').innerHTML =
                'Слоёв: ' + Object.keys(layerGroups).length +
                '. Галочка — гравировать слой, S — мощность, F — скорость. Формат файла: G90 / G21 / M4 S0 … M5 S0 (как в gcodeide).';
            document.getElementById('drc-info').innerText =
                'Центр платы по X = ' + window._boardCenterX.toFixed(3) + ' ед. Нажмите «Анализировать зазоры».';
        } catch (err) {
            console.error(err);
            const el = document.getElementById('error-log');
            el.style.display = 'block';
            el.innerText = 'Ошибка парсинга DXF: ' + err.message + '\n' + err.stack;
            alert('Ошибка парсинга DXF: ' + err.message);
        }
        document.getElementById('loading').style.display = 'none';
    }, 50);
}

document.getElementById('dxf-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => loadDXFText(evt.target.result);
    reader.readAsText(file);
});

document.getElementById('cnc-generate').addEventListener('click', generateGCode);
document.getElementById('drill-generate').addEventListener('click', generateDrillGCode);

document.getElementById('cnc-download').addEventListener('click', () => {
    if (!window._lastGCode) return;
    const blob = new Blob([window._lastGCode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mill.nc';
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('drill-download').addEventListener('click', () => {
    if (!window._lastDrillGCode) return;
    const blob = new Blob([window._lastDrillGCode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drill.nc';
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('cnc-show-path').addEventListener('change', e => {
    toolpathGroup.visible = e.target.checked;
});

document.getElementById('drill-show-marks').addEventListener('change', e => {
    drillGroup.visible = e.target.checked;
});

document.getElementById('laser-generate').addEventListener('click', generateLaserGCode);

document.getElementById('laser-download').addEventListener('click', () => {
    if (!window._lastLaserGCode) return;
    const blob = new Blob([window._lastLaserGCode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'laser.gcode';
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('laser-show-path').addEventListener('change', e => {
    laserGroup.visible = e.target.checked;
});

// Переключение режима лазера: показываем параметры заливки и подсказку
function updateLaserModeUI() {
    const mode = laserFillMode();
    const box = document.getElementById('laser-fill-opts');
    if (box) box.style.display = (mode === 'contour') ? 'none' : 'flex';

    const info = document.getElementById('laser-info');
    if (!info) return;
    if (mode === 'contour') {
        info.innerHTML = 'G90 / G21 / M4 S0 … M5 S0 — тот же формат, что в gcodeide. ' +
            'Гравируются контуры «как нарисовано» (центральные линии дорожек, площадки, HATCH).';
    } else if (mode === 'fill-rings') {
        info.innerHTML = 'Заливка «кольца от меди» — как «zapolnit dlya lazera krasivo»: ' +
            'контур меди, затем кольца с шагом X/Y. Отступ X/Y от дорожек — из-за овального пятна лазера ' +
            '(номинал по Y + анизотропия по X, значения по умолчанию — как в gcodeide: 0.125 / 0.09). ' +
            'Формат G-code тот же: G90 / G21 / M4 S0 … M5 S0.';
    } else {
        info.innerHTML = 'Заливка «штриховка пустот» — как «zapolnit dlya lazera»: ' +
            'горизонтальные линии через плату с шагом по Y, из них вычитается медь с отступом X/Y. ' +
            'Формат G-code тот же: G90 / G21 / M4 S0 … M5 S0.';
    }
}

document.getElementById('laser-mode').addEventListener('change', updateLaserModeUI);

// Овальное пятно: пресет/номинал/анизотропия -> отступы X/Y (X = номинал + анизотропия).
// Значения полей X/Y остаются источником для G-code — их можно править и напрямую.
const laserPresetEl = document.getElementById('laser-fill-preset');
if (laserPresetEl) laserPresetEl.addEventListener('change', applyLaserFillPreset);
['laser-fill-nom', 'laser-fill-aniso'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', syncLaserFillOffsets);
});
// при загрузке ставим значения по умолчанию «как в gcodeide» (Altium заливка: 0.125 / 0.09)
applyLaserFillPreset();

updateLaserModeUI();

// Пространство Space вкл/выкл траекторию — только в рабочей области генерации.
window.addEventListener('keydown', e => {
    const inGenWs = document.body.dataset.ws === 'gen';
    if (e.code === 'Space' && inGenWs && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        const cb = document.getElementById('cnc-show-path');
        cb.checked = !cb.checked;
        toolpathGroup.visible = cb.checked;
    }
    if (e.code === 'Escape' && inGenWs) {
        clearMeasure();
        measureActive = false;
        const mb = document.getElementById('measure-btn');
        mb.classList.remove('active');
        mb.innerText = 'Включить измерение';
        renderer.domElement.style.cursor = '';
    }
});

// ============================================================
// 17. DRC-LITE: ИНТЕРФЕЙС АНАЛИЗАТОРА ЗАЗОРОВ
// ============================================================
const drcGroup = new THREE.Group();
drcGroup.name = 'drc-markers';
scene.add(drcGroup);

function clearDRC() {
    while (drcGroup.children.length) {
        const c = drcGroup.children.pop();
        if (c.geometry) c.geometry.dispose();
    }
}

// Радиус маркеров подбирается по удалению камеры — чтобы точки
// было видно и на 5-мм, и на 200-мм плате.
function markerRadius() {
    const d = controls.target.distanceTo(camera.position);
    return Math.max(0.02, d * 0.008);
}

function addSceneMarker(group, pos, color, order) {
    const m = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius(), 10, 10),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
    );
    m.position.copy(pos);
    m.renderOrder = order;
    group.add(m);
    return m;
}

function analyzeAndRenderDRC() {
    if (!window._parsedDXF) { alert('Сначала загрузите DXF файл.'); return; }
    if (!CLIPPER) { alert('Clipper не загружен.'); return; }

    const scale     = parseFloat(document.getElementById('cnc-scale').value) || 1;
    const lineWidth = Math.max(0, parseFloat(document.getElementById('cnc-line-width').value) || 0.1);
    const onlyVis   = document.getElementById('cnc-only-visible').checked;
    const toolR     = parseFloat(document.getElementById('cnc-tool-r').value) || 0;
    const maxGapMm  = Math.max(0.05, domNum('drc-max-gap', 0.5));

    const isVisible = name => !onlyVis || !layerGroups[name] || layerGroups[name].visible;

    // Зазоры считаются в единицах DXF → переводим пороги из мм
    const maxGapDxf = maxGapMm / scale;
    const toolDDxf  = (toolR * 2) / scale;

    const info = document.getElementById('drc-info');
    const loadingEl = document.getElementById('loading');
    info.innerText = 'Анализ зазоров...';
    loadingEl.style.display = 'block';

    setTimeout(() => {
        try {
            const r = analyzeDRC(window._parsedDXF, isVisible, lineWidth, {
                maxGap: maxGapDxf, toolD: toolDDxf
            });
            clearDRC();

            // Маркеры самых узких мест (5 шт.)
            r.pairs.slice(0, 5).forEach((p, i) => {
                addSceneMarker(drcGroup, new THREE.Vector3(p.pt.x, p.pt.y, 0),
                               i === 0 ? 0xff3355 : 0xffaa33, 1002);
            });

            const toolDmm = toolR * 2;
            const rows = r.pairs.slice(0, 5).map((p, i) =>
                (i + 1) + ') <b>' + (p.d * scale).toFixed(3) + ' мм</b> @ (' +
                p.pt.x.toFixed(3) + '; ' + p.pt.y.toFixed(3) + ')'
            ).join('<br>');

            let html = '';
            html += 'Медных зон: <b>' + r.zoneCount + '</b> (внешних ' + r.outerCount + '), из ' +
                    r.rawCount + ' примитивов<br>';
            if (r.zoneCount === 0) {
                html += '<span class="bad">Медных зон не найдено — включите медные слои ' +
                        '(Top/Bottom-Layer) в списке слоёв или снимите галочку ' +
                        '«Только видимые слои»</span><br>';
            }
            html += 'Площадь меди: ' + (r.copperArea * scale * scale).toFixed(2) + ' мм²<br>';

            if (isFinite(r.minGap)) {
                const bad = (toolDmm > 0) && ((r.minGap * scale) < toolDmm);
                html += 'Минимальный зазор: <b class="' + (bad ? 'bad' : 'ok') + '">' +
                        (r.minGap * scale).toFixed(3) + ' мм</b>' +
                        (r.touching > 0
                            ? ' <span class="bad">(сомкнутых пар зон: ' + r.touching + ')</span>'
                            : '') +
                        '<br>';
            } else {
                html += 'Зазоров меньше ' + maxGapMm.toFixed(2) + ' мм не найдено<br>';
            }

            if (toolDmm > 0) {
                html += (r.nearTool > 0)
                    ? '<span class="bad">⚠ Фреза Ø' + toolDmm.toFixed(2) + ' мм не влезает в ' +
                      r.nearTool + ' парах(е) зон</span><br>'
                    : '<span class="ok">✓ Фреза Ø' + toolDmm.toFixed(2) + ' мм проходит между зонами</span><br>';
            }

            if (rows) html += 'Самые узкие места:<br>' + rows + '<br>';
            html += '<span style="color:#888">Проверено пар: ' + r.tested + ' (радиус ' +
                    (r.searchGap * scale).toFixed(2) + ' мм) | время ' + r.ms.toFixed(0) +
                    ' мс (геометрия ' + r.times.extract.toFixed(0) + ', union ' + r.times.union.toFixed(0) +
                    ', зазоры ' + r.times.pairs.toFixed(0) + ')</span>';

            info.innerHTML = html;
            console.log('[DRC]', r);
            loadingEl.style.display = 'none';
        } catch (err) {
            console.error(err);
            loadingEl.style.display = 'none';
            info.innerText = 'Ошибка анализа: ' + err.message;
        }
    }, 50);
}

document.getElementById('drc-generate').addEventListener('click', analyzeAndRenderDRC);
document.getElementById('drc-clear').addEventListener('click', () => {
    clearDRC();
    document.getElementById('drc-info').innerHTML =
        'Маркеры сброшены. ' + document.getElementById('drc-info').innerHTML;
});

// ============================================================
// 18. ИЗМЕРЕНИЕ РАССТОЯНИЙ (две точки)
// ============================================================
const measureGroup = new THREE.Group();
measureGroup.name = 'measure';
scene.add(measureGroup);

let measureActive = false;
let measurePts = [];
const measureRaycaster = new THREE.Raycaster();
const measureNDC = new THREE.Vector2();
const measurePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function clearMeasure() {
    measurePts = [];
    while (measureGroup.children.length) {
        const c = measureGroup.children.pop();
        if (c.geometry) c.geometry.dispose();
    }
    const el = document.getElementById('measure-info');
    if (el) el.innerHTML = 'ЛКМ по модели — точка 1, затем точка 2. Esc — сброс.';
}

// Точка под курсором: сначала по геометрии DXF, иначе по плоскости Z=0
function measurePickPoint(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    measureNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    measureNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    measureRaycaster.setFromCamera(measureNDC, camera);

    const targets = Object.values(layerGroups).filter(g => g.visible);
    if (targets.length) {
        const hits = measureRaycaster.intersectObjects(targets, true);
        if (hits.length) return hits[0].point.clone();
    }
    const v = new THREE.Vector3();
    const hit = measureRaycaster.ray.intersectPlane(measurePlane, v);
    return hit ? v.clone() : null;
}

function renderMeasure() {
    while (measureGroup.children.length) {
        const c = measureGroup.children.pop();
        if (c.geometry) c.geometry.dispose();
    }
    const colors = [0x33ddff, 0xffdd33];
    measurePts.forEach((p, i) => {
        addSceneMarker(measureGroup, p, colors[i % 2], 1001);
    });

    const el = document.getElementById('measure-info');
    const scale = parseFloat(document.getElementById('cnc-scale').value) || 1;

    if (measurePts.length === 1) {
        const a = measurePts[0];
        el.innerHTML = 'Точка 1: (' + a.x.toFixed(3) + '; ' + a.y.toFixed(3) + '). Укажите точку 2.';
        return;
    }
    if (measurePts.length < 2) return;

    const a = measurePts[0], b = measurePts[1];
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x33ddff, depthTest: false }));
    line.renderOrder = 1001;
    measureGroup.add(line);

    const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const dx = b.x - a.x, dy = b.y - a.y;

    el.innerHTML =
        'P1 (' + a.x.toFixed(3) + '; ' + a.y.toFixed(3) + ')  →  ' +
        'P2 (' + b.x.toFixed(3) + '; ' + b.y.toFixed(3) + ')<br>' +
        '<b>L = ' + L.toFixed(3) + ' ед. = ' + (L * scale).toFixed(3) + ' мм</b><br>' +
        'ΔX = ' + dx.toFixed(3) + ' ед. (' + (dx * scale).toFixed(3) + ' мм)<br>' +
        'ΔY = ' + dy.toFixed(3) + ' ед. (' + (dy * scale).toFixed(3) + ' мм)' +
        (Math.abs(b.z - a.z) > 1e-6 ? '<br>ΔZ = ' + (b.z - a.z).toFixed(3) + ' ед.' : '');
}

let measureDownPos = null;

renderer.domElement.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    measureDownPos = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerup', e => {
    if (!measureActive || !measureDownPos) return;
    const moved = Math.hypot(e.clientX - measureDownPos.x, e.clientY - measureDownPos.y);
    measureDownPos = null;
    if (moved > 4) return;                 // это было вращение/панорамирование камеры

    const p = measurePickPoint(e.clientX, e.clientY);
    if (!p) return;
    if (measurePts.length >= 2) measurePts = [];   // третья точка — новое измерение
    measurePts.push(p);
    renderMeasure();
});

document.getElementById('measure-btn').addEventListener('click', () => {
    measureActive = !measureActive;
    const b = document.getElementById('measure-btn');
    b.classList.toggle('active', measureActive);
    b.innerText = measureActive ? 'Измерение включено (клик по модели)' : 'Включить измерение';
    renderer.domElement.style.cursor = measureActive ? 'crosshair' : '';
    if (!measureActive) clearMeasure();
});

document.getElementById('measure-clear').addEventListener('click', clearMeasure);

let lastView = { w: _view0.w, h: _view0.h };

function syncViewport() {
    const s = viewSize();
    if (s.w === lastView.w && s.h === lastView.h) return;
    lastView = s;
    camera.aspect = s.w / s.h;
    camera.updateProjectionMatrix();
    renderer.setSize(s.w, s.h);
}

window.addEventListener('resize', syncViewport);

function animate() {
    requestAnimationFrame(animate);
    // Рисуем только когда видна рабочая область «Генерация».
    if (document.body.dataset.ws === 'gen') {
        syncViewport();
        controls.update();
        renderer.render(scene, camera);
    }
}
animate();
