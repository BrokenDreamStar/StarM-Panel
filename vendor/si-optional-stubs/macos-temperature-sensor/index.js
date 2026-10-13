/**
 * `macos-temperature-sensor` 的占位实现。
 *
 * systeminformation（lib/cpu.js 的 cpuTemperature、lib/graphics.js 的 darwin 分支）
 * 用它读 CPU / GPU 温度。真实实现是原生模块，本项目不引入（会破坏单文件交叉编译）。
 * 返回空对象即「没有任何温度数据」，与真实依赖未安装时 si 的降级结果一致。
 */
module.exports = {
  temperature: () => ({}),
}
