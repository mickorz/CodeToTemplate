// 假仓库入口：供失败注入测试使用
const supervisor = require("./src/supervisor");
const RETRY_MS = [500, 2000, 5000];
console.log(supervisor.create({ retry: RETRY_MS }));
