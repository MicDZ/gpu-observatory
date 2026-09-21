<p><img src="public/icons/icon.svg" width="80" height="80" alt="GPU Observatory icon"></p>

# GPU Observatory

**在一个紧凑的面板里，查看多台主机的显卡由哪个用户、哪个进程占用。**

[English](README.md) · [给 Agent 的部署文档](docs/DEPLOYMENT_FOR_AGENTS.md) · [安全说明](SECURITY.md) · [MIT 许可](LICENSE)

这是一个自托管、主动上报的 NVIDIA GPU 监控面板，同时支持 CPU、系统内存以及可选的 Slurm 队列。各台主机向中心服务器推送数据，登录后统一查看。

![GPU 总览与进程明细，全部为虚构数据](docs/images/gpu-overview.png)

**所有效果图均来自独立的虚拟面板。主机名、用户、任务和指标全部为合成数据，不包含真实部署信息。**

## 用户与设备管理

管理员可以创建用户账号，并查看仅含所属用户、设备名称和 GPU 型号的设备清单。每个用户拥有独立的“我的设备”页面，只查看和管理自己的设备；可以添加、重命名和移除设备。点击“添加设备”后复制安装命令，在自己的 Linux GPU 服务器上运行，即可自动安装依赖、注册到当前中心并通过隔离的 PM2 启动上报端，无需 sudo。安装链接 15 分钟有效，只能注册一次。

![用户和设备管理，全部为虚构数据](docs/images/devices.png)

[用户管理与升级文档](docs/USER_MANAGEMENT.md)包含账号权限、一键安装、撤销凭据、失败恢复和旧版本迁移。原账号自动成为管理员，原设备继续归它所有。

## 功能

- 历史分析：SQLite 保存历史汇总，查看每日利用率、显存趋势、GPU 用量与进程用户占卡排行；支持日期和设备筛选。[存储与统计口径](docs/HISTORY.md)
- GPU 利用率、显存、温度、功耗；展开查看用户名、PID、进程名与占用显存。
- CPU 独立标签页：总利用率、各核心热力图、负载、进程占用和用户。
- 内存独立标签页：RAM、可用内存、缓存、Swap、带用户名的进程 RSS 排名。RSS 包含共享页，不能直接相加作为用户独占内存。
- 可选 Slurm 面板：账号可见的排队/运行任务、分区、原因、优先级、等待和运行时长。前端每秒推算时长，过期数据停止推算。
- 中文/英文切换、紧凑布局、搜索、空闲筛选、点击展开、移动端适配、PWA 安装。
- GPU/CPU/内存每 5 秒上报；Slurm 至少间隔 60 秒查询。中心服务器不会通过 SSH 轮询主机。
- 密码登录、每台主机独立令牌、HTTPS、接口限流；PM2 用户态部署，无需 sudo。

## 必须有一台中心服务器

可以是 VPS、家用服务器、Mac 或长期在线的工作站，**不需要 GPU**。它负责运行网站并接收所有主机的 HTTPS 上报，因此需要持续开机联网。中心运行 Node.js 22.16+；GPU 上报端目前支持 Linux NVIDIA 主机，需要 Python 3.10+、可用驱动/NVML，以及管理进程的 Node/PM2。

**没有域名：使用 Cloudflare Quick Tunnel 起步。** 无需注册 Cloudflare 账号或购买域名，会获得随机的 `*.trycloudflare.com` HTTPS 地址。但隧道每次重启后地址都会变化，需要更新中心配置及所有上报端地址。它面向开发测试，没有可用性保证，有 200 并发请求限制，不支持 SSE；本项目使用轮询。[官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

**长期使用：推荐自己的域名和具名隧道。** 地址固定，上报端、书签和已安装的桌面应用都更方便；需要 Cloudflare 账号与已配置的域名，也可使用已有的 HTTPS 反向代理。

## 先试试虚拟面板

不需要 GPU、账号或 Python 依赖：

```sh
git clone <本仓库地址> gpu-observatory
cd gpu-observatory
npm run demo
```

打开 **http://127.0.0.1:8790**。演示服务仅监听本机，只使用虚构数据，不读取真实机器指标或生产配置，不能作为正式部署使用。

## 让 Agent 帮你部署

把下面的话交给 Agent，并私下提供中心服务器及 GPU 主机的 SSH 信息：

> 按照 AGENTS.md 和 docs/DEPLOYMENT_FOR_AGENTS.md 部署 GPU Observatory。使用一台中心服务器，先接入一台 GPU 主机验证，再接入其余已授权主机。如果我没有域名，使用 Cloudflare Quick Tunnel，并说明地址变化后的处理方式。密码、令牌和主机清单放在仓库外。使用隔离的用户态 PM2，不使用 sudo。验证鉴权、数据新鲜度和进程恢复；接入 Slurm 前检查集群政策。

[完整部署文档](docs/DEPLOYMENT_FOR_AGENTS.md)包含初始化、两种隧道方案、单独注册主机、上报端安装、PM2、Linux 开机恢复、macOS 登录后启动、Slurm、故障排查、更新和回滚。集群上的持久进程及开机设置需要符合所在站点政策。

Quick Tunnel 换址后，`manage.mjs set-origin` 会保留凭据并更新中心配置和本地注册文件；还需要将各自的配置安全分发至对应上报端并重启。它不会自动修改远端主机。[换址步骤](docs/DEPLOYMENT_FOR_AGENTS.md#7-when-a-quick-tunnel-url-changes)

## 更多效果图

<details>
<summary><strong>历史趋势与 GPU 用量排行</strong></summary>

![虚构历史数据与排行榜](docs/images/history.png)

</details>

<details>
<summary><strong>一键安装上报端</strong></summary>

![一次性安装链接的虚构示例](docs/images/device-install.png)

</details>

<details>
<summary><strong>CPU：各核心利用率与进程用户</strong></summary>

![CPU 虚构面板](docs/images/cpu.png)

</details>

<details>
<summary><strong>内存：RAM 明细与带用户名的进程 RSS</strong></summary>

![内存虚构面板](docs/images/memory.png)

</details>

<details>
<summary><strong>Slurm：排队原因、运行任务与实时计时</strong></summary>

![Slurm 虚构面板](docs/images/slurm.png)

</details>

## 使用边界

本项目面向小型主机集群，保存实时快照及 SQLite 历史汇总，默认保留 30 天分钟汇总和 365 天每日汇总。它不是分布式监控或企业级身份平台。不同用户分别登录，只能查看自己的设备及分配给自己的 Slurm 来源；管理员负责管理账号，中心重启后需要重新登录。进程可见性取决于操作系统权限；未知数据不会伪装成零。

Slurm 只显示采集账号被允许查看的任务，空队列不代表集群空闲。部署时无需提交 GPU 测试任务。PWA 安装取决于浏览器、操作系统和 HTTPS 条件；离线时只展示占位页，不缓存私有指标。

开发与测试步骤见 [English README](README.md#development) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。使用 [gpustat](https://github.com/wookayin/gpustat)、[psutil](https://github.com/giampaolo/psutil) 及 NVIDIA NVML 绑定；项目采用 MIT 许可，依赖保留各自许可。
