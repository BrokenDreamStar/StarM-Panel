/**
 * `osx-temperature-sensor` 的占位实现。
 *
 * systeminformation（lib/cpu.js 的 cpuTemperature）在 macOS 上会调用本模块，
 * 真实实现是原生/脚本模块，本项目不引入（会破坏单文件交叉编译）。
 * 这里保持「读不到温度」的既有行为：si 拿到 main = null，能力位 cpuTemp = false。
 */
module.exports = {
  cpuTemperature: () => ({ main: null, cores: [], max: null, socket: [], chipset: null }),
}
