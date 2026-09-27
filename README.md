# 642-CHO | 机器人与灵巧手实践

浙江大学 · 机械工程本科在读 · 2024–2028

关注 **灵巧手、视觉遥操作与机器人软硬件集成**。从机械结构出发，把视觉输入、控制软件与执行机构连接起来，让人手动作在实体机器人上得到响应。

## 精选项目

### 基于 MediaPipe 的灵巧手视觉遥操作

[![腱驱灵巧手整机实物](https://raw.githubusercontent.com/642-CHO/dexterous-hand-teleoperation/main/assets/hand-overview.png)](https://github.com/642-CHO/dexterous-hand-teleoperation)

基于开源 AeroHand 的腱驱灵巧手项目，集成摄像头手部关键点检测、本地 Web 控制台与串口舵机控制，支持 **视觉连续跟随与预设手势调用** 两种模式，完成实机联调与现场路演。

**项目亮点**

- **从人手到机械手：** 将摄像头识别的人手姿态映射为七路执行器控制量，实现视觉连续跟随。
- **双模式交互：** 在连续跟随之外，提供预设手势调用，支持动作展示与功能验证。
- **软硬件贯通：** 围绕设备通信、运动端点标定、控制参数与实机行为开展集成和调试。

**技术关键词：** MediaPipe · Python · FastAPI · 串口通信 · 总线舵机 · 视觉遥操作

[打开控制台交互演示 →](https://642-cho.github.io/642-CHO/control-console-demo/)

[查看项目与实机视频 →](https://github.com/642-CHO/dexterous-hand-teleoperation)

## 技术与实践

| 方向 | 项目接触与实践 |
| --- | --- |
| 视觉与交互 | MediaPipe 手部关键点检测、手指姿态映射、视觉连续跟随 |
| 编程与软件 | Python、FastAPI 本地上位机项目应用；C 语言、MATLAB 基础 |
| 控制与调试 | 串口通信、STS3215 总线舵机、运动端点标定、软硬件联调 |
| 机械与硬件 | 腱驱灵巧手装配与调试、3D 打印；SolidWorks、AutoCAD 课程应用 |

## 关注方向

希望在机器人控制工具、灵巧手遥操作与系统集成相关实践中，进一步提升编程、机器人学与工程调试能力。
