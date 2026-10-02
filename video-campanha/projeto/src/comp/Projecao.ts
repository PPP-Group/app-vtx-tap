// Projeção de um ponto de um plano com "perspective(d) rotateX(rx) rotateZ(rz) scale(s)"
// para coordenadas de tela, relativas à origem da transformação.
export function projetar(x: number, y: number, z: number, cam: { d: number; rx: number; rz: number; s: number }) {
  const rx = (cam.rx * Math.PI) / 180;
  const rz = (cam.rz * Math.PI) / 180;
  let X = x * cam.s;
  let Y = y * cam.s;
  let Z = z * cam.s;
  const x1 = X * Math.cos(rz) - Y * Math.sin(rz);
  const y1 = X * Math.sin(rz) + Y * Math.cos(rz);
  X = x1;
  Y = y1;
  const y2 = Y * Math.cos(rx) - Z * Math.sin(rx);
  const z2 = Y * Math.sin(rx) + Z * Math.cos(rx);
  Y = y2;
  Z = z2;
  const k = cam.d / (cam.d - Z);
  return { x: X * k, y: Y * k, escala: k * cam.s };
}
