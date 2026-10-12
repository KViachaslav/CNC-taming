<script type="module">
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

  const container = document.getElementById('canvas3dContainer');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);
  scene.fog = new THREE.FogExp2(0x0a0a1a, 0.002);

  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
  camera.position.set(80, 60, 100);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  function showLoading(show) {
    let loadingDiv = document.getElementById('loadingOverlay');
    if (show) {
      if (!loadingDiv) {
        loadingDiv = document.createElement('div');
        loadingDiv.id = 'loadingOverlay';
        loadingDiv.className = 'loading-overlay';
        loadingDiv.innerHTML = `
          <div class="loading-spinner">
            <div class="spinner"></div>
            <span>Загрузка 3D модели...</span>
          </div>
        `;
        container.style.position = 'relative';
        container.appendChild(loadingDiv);
      }
      loadingDiv.style.display = 'flex';
    } else {
      if (loadingDiv) {
        loadingDiv.style.display = 'none';
      }
    }
  }

  const controls3d = new OrbitControls(camera, renderer.domElement);
  controls3d.enableDamping = true;
  controls3d.dampingFactor = 0.05;
  controls3d.autoRotate = false;
  controls3d.enableZoom = true;
  controls3d.zoomSpeed = 1.2;
  controls3d.target.set(0, 0, 0);

  // Освещение
  const ambientLight = new THREE.AmbientLight(0x404060);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(1, 2, 1);
  scene.add(directionalLight);
  const fillLight = new THREE.PointLight(0x445566, 0.5);
  fillLight.position.set(0, -5, 0);
  scene.add(fillLight);
  const backLight = new THREE.DirectionalLight(0x88aaff, 0.4);
  backLight.position.set(-1, 1, -1);
  scene.add(backLight);

  let axesHelper = new THREE.AxesHelper(60);
  let gridHelper = new THREE.GridHelper(200, 40, 0x88aaff, 0x335588);
  gridHelper.position.y = -0.1;
  scene.add(axesHelper);
  scene.add(gridHelper);

  const chkAxes = document.getElementById('chkAxes');
  const chkGrid3d = document.getElementById('chkGrid3d');
  const chkPoints = document.getElementById('chkPoints');
  const chkTool = document.getElementById('chkTool');
  const chkHm = document.getElementById('chkHm');
  
  chkAxes.addEventListener('change', (e) => { axesHelper.visible = e.target.checked; });
  chkGrid3d.addEventListener('change', (e) => { gridHelper.visible = e.target.checked; });
  chkTool.addEventListener('change', () => { updateToolMarkerVisibility(); });
  chkHm.addEventListener('change', () => { updateHeightMapVisibility(); });
  
  let currentG1Lines = null;
  let currentG0Lines = null;
  let currentPointsGroup = null;
  let g1SegmentColors = []; // Массив цветов для каждого сегмента G1
  let g1ColorAttribute = null; // Ссылка на атрибут цвета для обновления

  function clearTrajectory() {
    if (currentG1Lines) {
      scene.remove(currentG1Lines);
      if (currentG1Lines.geometry) currentG1Lines.geometry.dispose();
      if (currentG1Lines.material) currentG1Lines.material.dispose();
      currentG1Lines = null;
    }
    if (currentG0Lines) {
      scene.remove(currentG0Lines);
      if (currentG0Lines.geometry) currentG0Lines.geometry.dispose();
      if (currentG0Lines.material) currentG0Lines.material.dispose();
      currentG0Lines = null;
    }
    if (currentPointsGroup) {
      scene.remove(currentPointsGroup);
      currentPointsGroup = null;
    }
    g1SegmentColors = [];
    g1ColorAttribute = null;
    window.g1SegmentLineIdx = [];
    window.gcodeBBox = null;
  }

  function parseAndCreateLinesOptimized(gcodeText) {
    const lines = gcodeText.split(/\r?\n/);
    const points = [];
    const g1SegmentLineIdx = []; // для каждого G1-сегмента: индекс исходной строки G-code
    let currentX = 0, currentY = 0, currentZ = 0;
    let lastGCode = null;
    let lastPointType = 'G1';
    
    for (let li = 0; li < lines.length; li++) {
      let raw = lines[li].trim();
      if (raw === "") continue;
      
      let codeWithoutComment = raw.split(';')[0].toUpperCase().trim();
      if (codeWithoutComment === "") continue;
      codeWithoutComment = codeWithoutComment.replace(/\([^)]*\)/g, "").trim();
      if (codeWithoutComment === "") continue;
      
      let gMatch = codeWithoutComment.match(/G(?:0|1|2|3)?\d*/i);
      let currentGCode = null;
      
      if (gMatch) {
        currentGCode = gMatch[0].toUpperCase();
        lastGCode = currentGCode;
        if (currentGCode === 'G0' || currentGCode === 'G1') {
          lastPointType = currentGCode;
        }
      }
      
      let x = null, y = null, z = null;
      const xMatch = codeWithoutComment.match(/X([+-]?\d*\.?\d+)/i);
      const yMatch = codeWithoutComment.match(/Y([+-]?\d*\.?\d+)/i);
      const zMatch = codeWithoutComment.match(/Z([+-]?\d*\.?\d+)/i);
      
      if (xMatch) x = parseFloat(xMatch[1]);
      if (yMatch) y = parseFloat(yMatch[1]);
      if (zMatch) z = parseFloat(zMatch[1]);
      
      const hasCoordinates = (x !== null || y !== null || z !== null);
      const isMoveCommand = (currentGCode === 'G0' || currentGCode === 'G1' || 
                             (lastGCode === 'G0' || lastGCode === 'G1') && !currentGCode);
      
      if (hasCoordinates && isMoveCommand) {
        const newX = (x !== null) ? x : currentX;
        const newY = (y !== null) ? y : currentY;
        const newZ = (z !== null) ? z : currentZ;
        
        if (points.length === 0) {
          points.push({x: currentX, y: currentY, z: currentZ, type: lastPointType, src: -1});
        }
        
        points.push({x: newX, y: newY, z: newZ, type: lastPointType, src: li});
        
        currentX = newX;
        currentY = newY;
        currentZ = newZ;
      }
      
      if (currentGCode) {
        lastGCode = currentGCode;
      }
    }
    
    if (points.length < 2) return null;
    
    // Собираем вершины для G1 и G0
    const g1Vertices = [];
    const g0Vertices = [];
    const g1ColorMap = [];
    
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i+1];
      
      const x1 = p1.x, y1 = p1.z, z1 = p1.y;
      const x2 = p2.x, y2 = p2.z, z2 = p2.y;
      
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dz = z2 - z1;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      
      if (dist < 0.0001) continue;
      
      if (p2.type === 'G1') {
        g1Vertices.push(x1, y1, z1, x2, y2, z2);
        g1ColorMap.push(0xff5500); // Начальный цвет оранжевый
        g1SegmentLineIdx.push(p2.src);
      } else if (p2.type === 'G0') {
        g0Vertices.push(x1, y1, z1, x2, y2, z2);
      }
    }
    
    // Создаём LinesSegments для G1 с поддержкой цвета на сегмент
    let g1LinesObj = null;
    if (g1Vertices.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(g1Vertices), 3));
      
      // Создаём массив цветов для каждой вершины (по 3 float на вершину)
      const colors = new Float32Array(g1Vertices.length);
      for (let i = 0; i < g1ColorMap.length; i++) {
        const color = new THREE.Color(g1ColorMap[i]);
        // Каждый сегмент состоит из 2 вершин, записываем цвет для обеих
        for (let j = 0; j < 2; j++) {
          colors[i * 6 + j * 3] = color.r;
          colors[i * 6 + j * 3 + 1] = color.g;
          colors[i * 6 + j * 3 + 2] = color.b;
        }
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      
      const material = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 });
      g1LinesObj = new THREE.LineSegments(geometry, material);
      
      // Сохраняем данные для последующего обновления цветов
      g1SegmentColors = g1ColorMap.map(c => ({ color: c, sent: false }));
    }
    
    // G0 линии (серо-голубые, не меняют цвет)
    let g0LinesObj = null;
    if (g0Vertices.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(g0Vertices), 3));
      const material = new THREE.LineBasicMaterial({ color: 0x88aacc, linewidth: 1, transparent: true, opacity: 0.5 });
      g0LinesObj = new THREE.LineSegments(geometry, material);
    }
    
    document.getElementById('g1SegInfo').textContent = g1SegmentColors.length;
    document.getElementById('g0SegInfo').textContent = (g0Vertices.length / 6).toFixed(0);
    document.getElementById('totalCount').textContent = g1SegmentColors.length;
    document.getElementById('sentCount').textContent = '0';
    
    // Вычисляем bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    points.forEach(p => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });
    
    const sizeX = (maxX - minX).toFixed(1);
    const sizeY = (maxY - minY).toFixed(1);
    const sizeZ = (maxZ - minZ).toFixed(1);
    document.getElementById('bbInfo').textContent = `${sizeX} / ${sizeY} / ${sizeZ}`;

    // границы по X/Y в рабочих координатах — для сетки карты высот
    window.gcodeBBox = { minX: minX, maxX: maxX, minY: minY, maxY: maxY, minZ: minZ, maxZ: maxZ };
    
    // Опорные точки (опционально)
    const pointsGroup = new THREE.Group();
    const sphereGeometry = new THREE.SphereGeometry(0.3, 4, 4);
    const sphereMaterial = new THREE.MeshStandardMaterial({ color: 0xffaa55, emissive: 0x331100 });
    
    const step = Math.max(1, Math.floor(points.length / 800));
    for (let i = 0; i < points.length; i += step) {
      const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
      sphere.position.set(points[i].x, points[i].z, points[i].y);
      pointsGroup.add(sphere);
    }
    
    // карта «индекс G1-сегмента → индекс исходной строки G-code»
    window.g1SegmentLineIdx = g1SegmentLineIdx;

    return { g1Lines: g1LinesObj, g0Lines: g0LinesObj, pointsGroup: pointsGroup, g1Count: g1SegmentColors.length };
  }
  
  // Функция для обновления цвета отправленного сегмента
  window.markSegmentAsSent = function(segmentIndex) {
    if (segmentIndex < g1SegmentColors.length && !g1SegmentColors[segmentIndex].sent && currentG1Lines) {
      g1SegmentColors[segmentIndex].sent = true;
      g1SegmentColors[segmentIndex].color = 0x4ade80;
      
      // Обновляем атрибут цвета в геометрии
      const geometry = currentG1Lines.geometry;
      const colorAttribute = geometry.attributes.color;
      if (colorAttribute) {
        const color = new THREE.Color(0x4ade80);
        // Обновляем обе вершины сегмента
        for (let j = 0; j < 2; j++) {
          colorAttribute.setXYZ(segmentIndex * 2 + j, color.r, color.g, color.b);
        }
        colorAttribute.needsUpdate = true;
      }
      
      // Обновляем счётчик
      const sentCount = g1SegmentColors.filter(s => s.sent).length;
      document.getElementById('sentCount').textContent = sentCount;
      const progress = (sentCount / g1SegmentColors.length) * 100;
      document.getElementById('progressFill').style.width = progress + '%';
    }
  };
  
  // Функция для сброса цветов
  window.resetColors = function() {
    if (currentG1Lines && g1SegmentColors.length > 0) {
      const geometry = currentG1Lines.geometry;
      const colorAttribute = geometry.attributes.color;
      if (colorAttribute) {
        for (let i = 0; i < g1SegmentColors.length; i++) {
          g1SegmentColors[i].sent = false;
          g1SegmentColors[i].color = 0xff5500;
          const color = new THREE.Color(0xff5500);
          for (let j = 0; j < 2; j++) {
            colorAttribute.setXYZ(i * 2 + j, color.r, color.g, color.b);
          }
        }
        colorAttribute.needsUpdate = true;
      }
      document.getElementById('sentCount').textContent = '0';
      document.getElementById('progressFill').style.width = '0%';
    }
  };
  
  window.updateGCodeVisualization = function(gcodeText) {
    return new Promise((resolve) => {
    showLoading(true);
    
    // Используем setTimeout для асинхронной обработки, чтобы не блокировать UI
    setTimeout(() => {
      try {
        clearTrajectory();
        const result = parseAndCreateLinesOptimized(gcodeText);
        if (result) {
          if (result.g1Lines) {
            currentG1Lines = result.g1Lines;
            scene.add(currentG1Lines);
          }
          if (result.g0Lines) {
            currentG0Lines = result.g0Lines;
            scene.add(currentG0Lines);
          }
          if (result.pointsGroup && chkPoints.checked) {
            currentPointsGroup = result.pointsGroup;
            scene.add(currentPointsGroup);
          }
          
          // Центрируем камеру
          if (currentG1Lines) {
            const box = new THREE.Box3().setFromObject(currentG1Lines);
            if (!box.isEmpty()) {
              const center = box.getCenter(new THREE.Vector3());
              controls3d.target.copy(center);
              const size = box.getSize(new THREE.Vector3());
              const maxDim = Math.max(size.x, size.y, size.z);
              const distance = maxDim * 1.5;
              camera.position.set(distance * 0.8, distance * 0.6, distance);
              controls3d.update();
            }
          }
        }
      } catch(e) {
        console.error('Ошибка визуализации:', e);
      } finally {
        showLoading(false);
        resolve();
      }
    }, 50);
    });
  };
  
  chkPoints.addEventListener('change', (e) => {
    if (currentPointsGroup) {
      if (e.target.checked) {
        scene.add(currentPointsGroup);
      } else {
        scene.remove(currentPointsGroup);
      }
    }
  });
  
  function animate() {
    requestAnimationFrame(animate);
    controls3d.update();
    renderer.render(scene, camera);
  }
  animate();
  
  window.addEventListener('resize', () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
  
  // Звёздный фон
  const starGeometry = new THREE.BufferGeometry();
  const starCount = 800;
  const starPositions = [];
  for (let i = 0; i < starCount; i++) {
    starPositions.push((Math.random() - 0.5) * 500);
    starPositions.push((Math.random() - 0.5) * 300);
    starPositions.push((Math.random() - 0.5) * 200 - 100);
  }
  starGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(starPositions), 3));
  const starMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.2 });
  const stars = new THREE.Points(starGeometry, starMaterial);
  scene.add(stars);
  
  /* ===================== положение инструмента (X/Y/Z) =====================
   * В сцене G-code Y идёт по оси Z, а G-code Z — по вертикали Y, т. е. точка
   * станка (x, y, z) рисуется в (x, z, y) — так же, как строятся траектории.  */

  let toolPos = null;                  // последняя известная позиция или null

  const toolMarker = new THREE.Group();
  const toolTip = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xffd166 })
  );
  toolMarker.add(toolTip);

  const toolBeamGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 28, 0)
  ]);
  toolMarker.add(new THREE.Line(toolBeamGeo,
    new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.55 })));

  const toolCrossGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-12, 0, 0), new THREE.Vector3(12, 0, 0),
    new THREE.Vector3(0, 0, -12), new THREE.Vector3(0, 0, 12)
  ]);
  toolMarker.add(new THREE.LineSegments(toolCrossGeo,
    new THREE.LineBasicMaterial({ color: 0x6ea8fe, transparent: true, opacity: 0.8 })));

  toolMarker.visible = false;
  scene.add(toolMarker);

  function fmtPos3(v) {
    return (v === null || v === undefined || !isFinite(v)) ? "—" : Number(v).toFixed(3);
  }

  function updateToolMarkerVisibility() {
    toolMarker.visible = !!(chkTool.checked && toolPos);
  }

  // Вызывается клиентом при каждом обновлении статуса станка.
  window.setToolPosition = function (x, y, z) {
    const out = document.getElementById('toolPos');
    if (x === null || x === undefined || y === null || y === undefined ||
        !isFinite(x) || !isFinite(y)) {
      toolPos = null;
      toolMarker.visible = false;
      if (out) out.textContent = "—";
      return;
    }
    const hasZ = !(z === null || z === undefined || !isFinite(z));
    const zz = hasZ ? z : 0;
    toolPos = { x: x, y: y, z: zz };
    toolMarker.position.set(x, zz, y);
    updateToolMarkerVisibility();
    if (out) out.textContent = fmtPos3(x) + " / " + fmtPos3(y) + " / " + (hasZ ? fmtPos3(z) : "—");
  };

  /* ===================== карта высот в 3D ===================== */

  let hmGroup = null;

  function disposeGroup(obj) {
    if (!obj) return;
    obj.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) {
          for (let i = 0; i < o.material.length; i++) o.material[i].dispose();
        } else {
          o.material.dispose();
        }
      }
    });
  }

  function updateHeightMapVisibility() {
    if (!hmGroup) return;
    if (chkHm.checked) {
      if (!hmGroup.parent) scene.add(hmGroup);
    } else {
      scene.remove(hmGroup);
    }
  }

  window.clearHeightMap = function () {
    if (!hmGroup) return;
    scene.remove(hmGroup);
    disposeGroup(hmGroup);
    hmGroup = null;
  };

  // nodes: [{x, y, z}] в рабочих координатах, nx*ny штук, порядок — по строкам Y.
  window.showHeightMap = function (nodes, nx, ny) {
    window.clearHeightMap();
    if (!nodes || !nodes.length || !(nx >= 1) || !(ny >= 1)) return;

    const group = new THREE.Group();
    const sphereGeo = new THREE.SphereGeometry(0.7, 8, 6);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x2dd4bf });
    const lineMat = new THREE.LineBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.6 });

    const hasZ = function (n) {
      return !!n && n.z !== null && n.z !== undefined && isFinite(n.z);
    };
    const vec = function (n) { return new THREE.Vector3(n.x, n.z, n.y); };

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n = nodes[j * nx + i];
        if (!hasZ(n)) continue;

        const s = new THREE.Mesh(sphereGeo, sphereMat);
        s.position.copy(vec(n));
        group.add(s);

        if (i + 1 < nx) {
          const m = nodes[j * nx + i + 1];
          if (hasZ(m)) group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([vec(n), vec(m)]), lineMat));
        }
        if (j + 1 < ny) {
          const m = nodes[(j + 1) * nx + i];
          if (hasZ(m)) group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([vec(n), vec(m)]), lineMat));
        }
      }
    }

    hmGroup = group;
    if (chkHm.checked) scene.add(hmGroup);
  };

  console.log('3D визуализация готова (оптимизированная версия)');
</script>
