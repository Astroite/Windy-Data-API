# Windy-Data-API

[Typhoon Watch](https://github.com/Astroite/WindyWallpaper)（Windows 天气壁纸）的数据快照流水线。
定时从 **Open-Meteo AWS 开放数据桶**（`s3://openmeteo`，无调用配额）和 **GDACS** 抓取西太平洋
天气数据，构建为静态 JSON 快照，托管在 **腾讯云 EdgeOne Pages** 上供所有壁纸客户端读取——
客户端不再直连上游 API，避免逐客户端撞 Open-Meteo 免费配额（约 1 万加权调用/天/IP）。

## 架构

```
GitHub 本仓库（只有流程文件，不存数据）
   │  .github/workflows/tick.yml：每 2h 把 main HEAD + 空提交 force-push 到 deploy 分支
   ▼
EO Pages（production 分支 = deploy）收到 push → 构建
   │  edgeone.json: buildCommand = npm run build（scripts/build.mjs 在 EO 构建机上抓数据）
   │  上游失败 → exit 1 → 构建失败 → 上一次成功部署继续在线（宁可旧数据不发空数据）
   ▼
CDN: /v1/meta.json /v1/grid-wide.json /v1/grid-fine.json /v1/storms.json
   ▼
壁纸客户端（Wallpaper Engine / 浏览器 / Tauri）：
   读快照 → 裁剪出自己视图的子网格；快照过期(>6h)或视图超出覆盖范围 → 回退直连 Open-Meteo API / GDACS
```

- **deploy 分支永远只比 main 多一个空提交**（force-push 重置），历史不膨胀；
  定期提交同时规避 GitHub「公共仓库 60 天无活动禁用定时 workflow」。
- **构建次数预算**：EO Pages 免费版 500 次/月；每 2h 一次 = 360 次/月，余量留给开发。
- **上游配额**：AWS 开放数据桶免账号、免出口流量费、无调用限制；GDACS 无配额。

## 数据设计

上游模式 `ncep_gfs013`（NOAA GFS，~13km，逐小时，6 小时更新一次），每个整点时间步一个
`.om` 文件（`data_spatial/<model>/<run>/<timestamp>.om`，内含全部变量，维度 `[ny,nx]`）。
风存 u/v 分量，speed/dir 由本流水线换算（与 Open-Meteo API 同约定：dir 为风的来向）。

发布两层固定网格（客户端按视图选层并裁剪子网格；域尺寸按 Web Mercator 视图跨度设计：
1920px 宽屏在 zoom 5 约横跨 84° 经度，加 20% padding 后 ~118°，所以默认区域视图由
global 层服务，zoom ≥ 6 才落进 wide 层。**客户端 `js/weather/api-snapshot.js` 里的层常量
必须与此表一致**）：

| 文件 | 范围 | 步长 | 点数 |
|---|---|---|---|
| `grid-global.json` | lat −60–70, 全经度（无重复列，客户端取模回绕） | 2.5° | 53×144 = 7632 |
| `grid-wide.json` | lat −15–50, lon 75–180 | 1.0° | 66×106 = 6996 |

每个网格文件的时间覆盖 = 当前整点 −1h 到 +6h（对齐客户端 `pastHours`/`forecastHours`），
`series` 与客户端 `WW.openMeteo.fetchGrid` 返回值同构（row-major，行=纬度从南到北，
列=经度从西到东，`{speed, dir, temp, precip}` 每点各 7~8 个小时值）：

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": 1751000000,          // unix 秒，客户端据此判断快照是否过期
  "model": "ncep_gfs013",
  "run": "2026/07/06/0000Z",
  "spec": { "lat0": 0, "lon0": 100, "step": 1, "nx": 61, "ny": 46 },
  "times": [1751000400, ...],          // unix 秒，逐小时
  "series": [ { "speed": [..], "dir": [..], "temp": [..], "precip": [..] }, ... ]
}
```

`storms.json` 是 GDACS 台风列表 + 轨迹的解析结果（结构与壁纸仓库
`js/weather/api-gdacs.js` 中 `WW.gdacs.fetchStorms` 的 resolve 值一致；解析逻辑是它的
Node 移植，两边改动需同步）。全球全量不做 bbox 过滤，客户端自行按视图筛选。
GDACS 失败不阻塞天气发布：`ok: false` 表示本轮降级，客户端应改走直连。

## 本地开发

```bash
npm install
npm run probe   # 先跑这个!验证 s3://openmeteo 的全部未确认假设（见下）
npm run build   # 完整构建，产物在 dist/
npx http-server dist -p 8080   # 本地预览
```

### probe 验证清单（首次部署前必须全绿）

`scripts/probe.mjs` 按序验证以下写代码时无法确认的事实，任何一步失败都会给出现场信息：

1. `latest.json` 的 schema 与 run 时间解析（官方未正式文档化，代码做了容错扫描）；
2. `@openmeteo/file-reader`（0.0.x 实验版）实例的实际方法名（children 枚举 API 未文档化）；
3. 时间步文件内的变量名清单；
4. `temperature_2m` 的维度 → 推导出的源网格参数（gfs013 可能是 0.117° 而非 0.125°，
   代码按维度自适应 + 最近邻取样，不依赖具体步长）；
5. 香港附近 3×3 采样值的气候合理性（7 月应为 26–33°C，验证网格方向/索引映射）;
6. **HTTP Range 行为**：`MemoryHttpBackend` 是局部读取还是整文件下载——决定每次构建
   流量是几 MB 还是上百 MB。

### probe 失败时的决策树

- **Range 不可用 / 整文件下载过大** → 改 `OM_MODEL=ncep_gfs025`（0.25°，变量少、文件小），
  或按 file-reader 的 backend 接口自写 Range backend；
- **file-reader 本身不可用**（WASM/API 问题）→ 放弃 EO 构建机抓取，退回备选方案：
  GitHub Actions + Python（herbie/cfgrib）读 NOAA GFS，`edgeone pages deploy ./dist` 直传，
  EO 退化为纯托管（本仓库结构不变，只是 build 移回 Actions）。

## EO Pages 控制台配置（一次性）

1. EO Pages 控制台 → 创建项目 → 关联本仓库；**production 分支选 `deploy`**（先在 Actions
   页手动 Run 一次 tick workflow 生成该分支，或本地 `git push origin main:deploy`）。
2. 构建配置自动读取 `edgeone.json`（installCommand/buildCommand/outputDirectory/headers），
   Node 版本用默认 22 即可。
3. 首次部署后验证：
   - `https://<项目域名>/v1/meta.json` 返回 JSON 且 `generatedAt` 是最近时间；
   - 响应头包含 `Access-Control-Allow-Origin: *`（壁纸在 CEF/WebView2 里 Origin 为 null，
     没有它客户端全部读不到）与 `Cache-Control: public, max-age=600`。
4. Actions 页确认 tick 定时在跑、EO 侧构建成功。
5. （可选）绑定自定义域名；国内 CDN 加速需要 ICP 备案，默认 `*.edgeone.app` 域名走海外节点。

## 许可与署名

- 天气数据：Open-Meteo 开放数据（数据源含 NOAA NCEP 等，开放许可，快照内置
  `/v1/attribution.json` 署名）；台风数据：GDACS。
- 依赖 `@openmeteo/file-reader` 为 **GPL-2.0**——只影响本流水线仓库（本就开源），
  不影响壁纸客户端（客户端只消费 JSON）。

## 客户端对接（壁纸仓库侧，待做）

- 新增 `js/weather/api-snapshot.js`：拉 `meta.json` → 按视图选 fine/wide → 裁剪子网格
  喂给现有 `WW.grid.assemble`；
- `refreshWeather`/`refreshStorms` 改为快照优先，过期/越界/失败回退现有直连路径；
- `WW.config.net` 增加 `snapshotBase` 与过期阈值。
