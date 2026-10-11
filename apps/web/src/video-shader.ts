/** Exact integer counterpart of packages/compute/src/video.ts; no CPU precision repair. */
export const videoShader = /* wgsl */ `
struct Parameters { dimensions: vec4<u32>, effects: vec4<i32>, color: vec4<i32> }
@group(0) @binding(0) var<uniform> settings: Parameters;
@group(0) @binding(1) var<storage, read> source: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
fn rgb(value: u32) -> vec3<i32> { return vec3<i32>(i32(value & 255u), i32((value >> 8u) & 255u), i32((value >> 16u) & 255u)); }
fn luma(value: vec3<i32>) -> i32 { return (77 * value.x + 150 * value.y + 29 * value.z + 128) >> 8; }
fn rounded(value: i32, denominator: i32) -> i32 {
  if (value < 0) { return -((-value + denominator / 2) / denominator); }
  return (value + denominator / 2) / denominator;
}
fn roundVector(value: vec3<i32>, denominator: i32) -> vec3<i32> {
  return vec3<i32>(rounded(value.x, denominator), rounded(value.y, denominator), rounded(value.z, denominator));
}
@compute @workgroup_size(16, 8)
fn main(@builtin(global_invocation_id) index: vec3<u32>) {
  let width = settings.dimensions.x;
  let height = settings.dimensions.y;
  if (index.x >= width || index.y >= settings.dimensions.w) { return; }
  let y = settings.dimensions.z + index.y;
  let original = source[y * width + index.x];
  let center = rgb(original);
  let denoise = settings.effects.x;
  let radius = settings.effects.y;
  let sharpen = settings.effects.z;
  var blur = center;
  var detail = center;
  if (denoise > 0 || sharpen > 0) {
    let centerLuma = luma(center);
    var weighted = vec3<i32>(0);
    var gaussian = vec3<i32>(0);
    var totalWeight = 0;
    for (var dy = -radius; dy <= radius; dy += 1) {
      let sy = u32(clamp(i32(y) + dy, 0, i32(height) - 1));
      for (var dx = -radius; dx <= radius; dx += 1) {
        let sx = u32(clamp(i32(index.x) + dx, 0, i32(width) - 1));
        let sample = rgb(source[sy * width + sx]);
        if (sharpen > 0 && abs(dx) <= 1 && abs(dy) <= 1) {
          gaussian += sample * (2 - abs(dx)) * (2 - abs(dy));
        }
        let weight = max(1, 256 - 4 * abs(luma(sample) - centerLuma)) * (radius + 1 - abs(dx)) * (radius + 1 - abs(dy));
        weighted += sample * weight;
        totalWeight += weight;
      }
    }
    blur = roundVector(weighted, totalWeight);
    if (sharpen > 0) { detail = roundVector(gaussian, 16); }
  }
  let filtered = clamp(roundVector(center * (100 - denoise) + blur * denoise, 100)
    + roundVector((center - detail) * sharpen, 100), vec3<i32>(0), vec3<i32>(255));
  let corrected = clamp(roundVector((filtered - vec3<i32>(128)) * settings.color.x, 100) + vec3<i32>(128 + rounded(settings.effects.w * 255, 100)), vec3<i32>(0), vec3<i32>(255));
  let gray = vec3<i32>(luma(corrected));
  let result = clamp(gray + roundVector((corrected - gray) * settings.color.y, 100), vec3<i32>(0), vec3<i32>(255));
  output[index.y * width + index.x] = u32(result.x) | (u32(result.y) << 8u) | (u32(result.z) << 16u) | (original & 0xff000000u);
}
`;
