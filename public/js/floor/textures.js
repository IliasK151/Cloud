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

export function carpetTexture() {
  const { ctx, texture } = canvasTexture(512, 512, { repeat: [14, 11] });
  const rnd = seeded(7);
  ctx.fillStyle = '#1a1f29';
  ctx.fillRect(0, 0, 512, 512);
  const img = ctx.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n + 2;
  }
  ctx.putImageData(img, 0, 0);
  // Carpet tile seams, alternating pile direction.
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      ctx.fillStyle = (tx + ty) % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.05)';
      ctx.fillRect(tx * 256, ty * 256, 256, 256);
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 512, 512);
  ctx.beginPath();
  ctx.moveTo(256, 0); ctx.lineTo(256, 512); ctx.moveTo(0, 256); ctx.lineTo(512, 256);
  ctx.stroke();
  texture.needsUpdate = true;
  return texture;
}

export function skylineTexture(seed = 3) {
  const W = 2048;
  const H = 640;
  const { ctx, texture } = canvasTexture(W, H);
  const rnd = seeded(seed);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#05070d');
  sky.addColorStop(0.55, '#0b1426');
  sky.addColorStop(0.85, '#1b2742');
  sky.addColorStop(1, '#2a2f45');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // stars
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.5})`;
    ctx.fillRect(rnd() * W, rnd() * H * 0.45, 1.2, 1.2);
  }
  // three layers of towers, back to front
  const layers = [
    { count: 60, hMin: 120, hMax: 300, color: '#0c1220', lit: 0.12 },
    { count: 42, hMin: 180, hMax: 430, color: '#0a0f1b', lit: 0.22 },
    { count: 26, hMin: 240, hMax: 560, color: '#070b14', lit: 0.3 },
  ];
  for (const layer of layers) {
    for (let i = 0; i < layer.count; i++) {
      const w = 40 + rnd() * 110;
      const x = rnd() * W - 40;
      const h = layer.hMin + rnd() * (layer.hMax - layer.hMin);
      const y = H - h;
      ctx.fillStyle = layer.color;
      ctx.fillRect(x, y, w, h);
      if (rnd() < 0.25) {
        ctx.fillRect(x + w * 0.4, y - 40, 3, 40);
        ctx.fillStyle = rnd() < 0.5 ? '#ff3b3b' : '#ffffff';
        ctx.fillRect(x + w * 0.4 - 1, y - 42, 5, 5);
      }
      const warm = rnd() < 0.6;
      for (let wy = y + 10; wy < H - 8; wy += 11) {
        for (let wx = x + 6; wx < x + w - 6; wx += 9) {
          if (rnd() < layer.lit) {
            const a = 0.45 + rnd() * 0.55;
            ctx.fillStyle = warm ? `rgba(255,214,150,${a})` : `rgba(180,215,255,${a})`;
            ctx.fillRect(wx, wy, 5, 6);
          }
        }
      }
    }
  }
  // haze
  const haze = ctx.createLinearGradient(0, H * 0.6, 0, H);
  haze.addColorStop(0, 'rgba(60,80,130,0)');
  haze.addColorStop(1, 'rgba(60,80,130,0.25)');
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

export function woodTexture() {
  const { ctx, texture } = canvasTexture(512, 128, { repeat: [1, 1] });
  const rnd = seeded(11);
  ctx.fillStyle = '#3b2a1f';
  ctx.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 80; i++) {
    ctx.strokeStyle = `rgba(${90 + rnd() * 40},${60 + rnd() * 25},${40 + rnd() * 20},0.35)`;
    ctx.lineWidth = 1 + rnd() * 2;
    ctx.beginPath();
    const y = rnd() * 128;
    ctx.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) ctx.lineTo(x, y + Math.sin(x / 60 + i) * 3);
    ctx.stroke();
  }
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
