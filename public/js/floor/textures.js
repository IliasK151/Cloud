import * as THREE from 'three';

// Procedural textures so the floor ships without any image assets.

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function canvasTexture(width, height, { repeat = null, srgb = true, anisotropy = 8 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  if (repeat) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
  }
  return { canvas, ctx, texture };
}

// Large-format polished concrete tiles.
export function floorTexture() {
  const { ctx, texture } = canvasTexture(1024, 1024, { repeat: [14, 12] });
  const rnd = seeded(7);
  ctx.fillStyle = '#6f6f6f';
  ctx.fillRect(0, 0, 1024, 1024);
  // Cloudy concrete: many soft blotches.
  for (let i = 0; i < 700; i++) {
    const x = rnd() * 1024;
    const y = rnd() * 1024;
    const r = 20 + rnd() * 120;
    const v = Math.floor(95 + rnd() * 50);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${v},${v},${v},0.08)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const img = ctx.getImageData(0, 0, 1024, 1024);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // Tile joints (2 × 2 tiles per texture repeat).
  ctx.strokeStyle = 'rgba(20,20,20,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 1024, 1024);
  ctx.beginPath();
  ctx.moveTo(512, 0); ctx.lineTo(512, 1024); ctx.moveTo(0, 512); ctx.lineTo(1024, 512);
  ctx.stroke();
  texture.needsUpdate = true;
  return texture;
}

// Low-pile rug with a fine weave, tinted by the material colour.
export function rugTexture() {
  const { ctx, texture } = canvasTexture(256, 256, { repeat: [30, 5] });
  const rnd = seeded(13);
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      const n = (rnd() - 0.5) * 36 + ((x + y) % 4 < 2 ? 6 : -6);
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
  }
  ctx.putImageData(img, 0, 0);
  texture.needsUpdate = true;
  return texture;
}

// The city outside at blue hour: warm horizon, lit towers, soft haze.
export function skylineTexture(seed = 3) {
  const W = 2048;
  const H = 768;
  const { ctx, texture } = canvasTexture(W, H);
  const rnd = seeded(seed);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0b1426');
  sky.addColorStop(0.45, '#1c2c4a');
  sky.addColorStop(0.72, '#3f4a66');
  sky.addColorStop(0.86, '#8a6c66');
  sky.addColorStop(1, '#c58b62');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const layers = [
    { count: 70, hMin: 90, hMax: 260, color: '#2a3148', lit: 0.1 },
    { count: 46, hMin: 160, hMax: 420, color: '#1c2236', lit: 0.2 },
    { count: 28, hMin: 240, hMax: 600, color: '#121726', lit: 0.3 },
  ];
  for (const layer of layers) {
    for (let i = 0; i < layer.count; i++) {
      const w = 50 + rnd() * 120;
      const x = rnd() * W - 40;
      const h = layer.hMin + rnd() * (layer.hMax - layer.hMin);
      const y = H - h;
      ctx.fillStyle = layer.color;
      ctx.fillRect(x, y, w, h);
      if (rnd() < 0.2) {
        ctx.fillRect(x + w * 0.45, y - 36, 3, 36);
        ctx.fillStyle = '#ff4d4d';
        ctx.fillRect(x + w * 0.45 - 1, y - 38, 5, 5);
      }
      for (let wy = y + 10; wy < H - 8; wy += 12) {
        for (let wx = x + 6; wx < x + w - 6; wx += 10) {
          if (rnd() < layer.lit) {
            const a = 0.35 + rnd() * 0.55;
            ctx.fillStyle = rnd() < 0.75 ? `rgba(255,212,160,${a})` : `rgba(200,225,255,${a})`;
            ctx.fillRect(wx, wy, 5, 6);
          }
        }
      }
    }
  }
  const haze = ctx.createLinearGradient(0, H * 0.55, 0, H);
  haze.addColorStop(0, 'rgba(120,110,130,0)');
  haze.addColorStop(1, 'rgba(160,120,110,0.28)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);
  texture.needsUpdate = true;
  return texture;
}

// Soft radial blob used as a cheap contact shadow under furniture.
export function blobTexture() {
  const { ctx, texture } = canvasTexture(128, 128, { srgb: false });
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.75)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  texture.needsUpdate = true;
  return texture;
}

// Rounded-rect path helper for canvas drawing.
export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
