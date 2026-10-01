// The battery saver's frame budget for the 3D floor. 0 means as fast as the display (60 to
// 120 frames a second on a MacBook), which is what the floor did before the saver.
//   eco:     the saver is on (Settings)
//   battery: the Mac is running on its battery
//   busy:    the camera is moving, a trader is talking, or the mouse/keyboard moved recently
//   focused: the browser window is the one in front
export function fpsFor({ eco = true, battery = false, busy = false, focused = true } = {}) {
  if (!eco) return 0;
  const watched = busy && focused;
  if (battery) return watched ? 24 : 6;
  return watched ? 30 : 15;
}
