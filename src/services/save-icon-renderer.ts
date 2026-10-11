import { nativeImage } from "electron";

const DEFAULT_SIZE = 256;
type Vertex = { x: number; y: number; z: number };
type UV = { u: number; v: number };
type Corner = { vertex: number; uv: number };
type Triangle = [Corner, Corner, Corner];

function parseIndex(text: string, count: number): number {
  const index = Number(text);
  return index < 0 ? count + index : index - 1;
}

/** Render the normal state of a PS2IODB OBJ model to a transparent square PNG. */
export function renderSaveIconPreview(
  obj: string, texturePng: Buffer, options: { yawOffset?: number; pitchOffset?: number; size?: number } = {}
): Buffer {
  const SIZE = options.size ?? DEFAULT_SIZE;
  if (!Number.isInteger(SIZE) || SIZE < 64 || SIZE > 512) throw new Error("Invalid icon preview size");
  const vertices: Vertex[] = [];
  const uvs: UV[] = [];
  const triangles: Triangle[] = [];
  for (const line of obj.split(/\r?\n/)) {
    if (line.startsWith("v ")) {
      const values = line.trim().split(/\s+/);
      vertices.push({ x: Number(values[1]), y: Number(values[2]), z: Number(values[3]) });
    } else if (line.startsWith("vt ")) {
      const values = line.trim().split(/\s+/);
      uvs.push({ u: Number(values[1]), v: Number(values[2]) });
    } else if (line.startsWith("f ")) {
      const parts = line.trim().split(/\s+/).slice(1);
      const corners = parts.map((part) => {
        const [v, vt] = part.split("/");
        return { vertex: parseIndex(v, vertices.length), uv: parseIndex(vt, uvs.length) };
      });
      for (let i = 1; i + 1 < corners.length; i++) {
        triangles.push([corners[0], corners[i], corners[i + 1]]);
      }
    }
  }
  if (!vertices.length || !uvs.length || !triangles.length ||
      vertices.some((v) => !Number.isFinite(v.x + v.y + v.z)) ||
      uvs.some((uv) => !Number.isFinite(uv.u + uv.v))) {
    throw new Error("Icon model has no renderable geometry");
  }
  const texture = nativeImage.createFromBuffer(texturePng);
  if (texture.isEmpty()) throw new Error("Icon texture could not be decoded");
  const { width: tw, height: th } = texture.getSize();
  if (tw < 1 || th < 1 || tw > 2048 || th > 2048) throw new Error("Icon texture has invalid dimensions");
  const tex = texture.getBitmap(); // Electron bitmap pixels are BGRA.
  const cx = (Math.min(...vertices.map((v) => v.x)) + Math.max(...vertices.map((v) => v.x))) / 2;
  const cy = (Math.min(...vertices.map((v) => v.y)) + Math.max(...vertices.map((v) => v.y))) / 2;
  const cz = (Math.min(...vertices.map((v) => v.z)) + Math.max(...vertices.map((v) => v.z))) / 2;
  const yaw = Math.PI - 0.24 + (options.yawOffset ?? 0);
  const pitch = -0.10 + (options.pitchOffset ?? 0);
  const rotated = vertices.map((v) => {
    const x = v.x - cx, y = v.y - cy, z = v.z - cz;
    const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
    const rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
    return { x: rx, y: y * Math.cos(pitch) - rz * Math.sin(pitch),
      z: y * Math.sin(pitch) + rz * Math.cos(pitch) };
  });
  const minX = Math.min(...rotated.map((v) => v.x));
  const maxX = Math.max(...rotated.map((v) => v.x));
  const minY = Math.min(...rotated.map((v) => v.y));
  const maxY = Math.max(...rotated.map((v) => v.y));
  const extent = Math.max(maxX - minX, maxY - minY);
  if (!Number.isFinite(extent) || extent <= 0) throw new Error("Icon model has invalid bounds");
  const scale = SIZE * 0.82 / extent;
  const projected = rotated.map((v) => ({
    x: SIZE / 2 + v.x * scale,
    y: SIZE / 2 - v.y * scale,
    z: v.z,
  }));
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE).fill(-Infinity);
  let painted = 0;
  for (const face of triangles) {
    const a = projected[face[0].vertex], b = projected[face[1].vertex], c = projected[face[2].vertex];
    const ta = uvs[face[0].uv], tb = uvs[face[1].uv], tc = uvs[face[2].uv];
    if (!a || !b || !c || !ta || !tb || !tc) continue;
    const area = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(area) < 0.0001) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const x1 = Math.min(SIZE - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const y1 = Math.min(SIZE - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const normalLength = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) || 1;
    const facing = Math.abs((ux * vy - uy * vx) / normalLength);
    const light = 0.70 + 0.30 * Math.min(1, facing);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const wa = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / area;
        const wb = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const u = Math.max(0, Math.min(1, wa * ta.u + wb * tb.u + wc * tc.u));
        const v = Math.max(0, Math.min(1, wa * ta.v + wb * tb.v + wc * tc.v));
        const tx = Math.min(tw - 1, Math.floor(u * tw));
        const ty = Math.min(th - 1, Math.floor((1 - v) * th));
        const source = (ty * tw + tx) * 4;
        if (tex[source + 3] < 16) continue;
        const pixel = y * SIZE + x;
        const z = wa * a.z + wb * b.z + wc * c.z;
        if (z <= depth[pixel]) continue;
        depth[pixel] = z;
        const dest = pixel * 4;
        pixels[dest] = Math.min(255, tex[source] * light);
        pixels[dest + 1] = Math.min(255, tex[source + 1] * light);
        pixels[dest + 2] = Math.min(255, tex[source + 2] * light);
        pixels[dest + 3] = tex[source + 3];
        painted++;
      }
    }
  }
  if (painted < 100) throw new Error("Icon preview rendered empty");
  const preview = nativeImage.createFromBitmap(pixels, { width: SIZE, height: SIZE }).toPNG();
  if (!preview.length) throw new Error("Icon preview could not be encoded");
  return preview;
}
