# 集思录亚洲 LOF 实时估值（Tampermonkey）

在 [集思录 QDII · 亚洲市场](https://www.jisilu.cn/data/qdii/#qdiia) 表格中增加两列：

- **实时估值(95%无汇率)**
- **实时溢价率**

仅对名称含 **LOF** 的基金计算；**不额外请求**集思录或第三方 API，降低封号风险。

---

## 公式

```text
实时估值 = 净值 × (1 + 指数涨幅 × 95%)
实时溢价率 = (现价 − 实时估值) / 实时估值 × 100%
```

- **净值**：表格「净值」列（盘前为上一交易日净值；晚间更新后作为下一交易日基准）。
- **指数涨幅**：表格「指数涨幅」列（如 `-0.47%`）。
- **不考虑汇率**；股票仓位固定 **95%**。

### 501305 验算

| 字段 | 值 |
|------|-----|
| 净值 | 1.2865 |
| 指数涨幅 | -0.47% |
| 实时估值 | ≈ 1.2808 |
| 现价 | 1.278 |
| 实时溢价率 | ≈ -0.22% |

---

## 故障排查（页面空白 / 无表格）

1. **先禁用脚本**，刷新 [QDII 亚洲市场](https://www.jisilu.cn/data/qdii/#qdiia)，确认不装脚本时表格能正常出现。
2. 若仅装脚本后空白：请更新到 **v1.1.0+**（已修复 Observer 与 FlexGrid 冲突）。
3. 在 Tampermonkey 中 **重新粘贴并保存** 最新 `jisilu-qdiia-lof-estimate.user.js`，硬刷新页面（Ctrl+F5）。
4. 非会员无「30 秒自动刷新」：使用表格上方 **「刷新估值列」** 按钮手动重算。
5. F12 → Console 搜索 `[集思录LOF估值]` 查看是否「列映射失败」。

---

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox）。
2. 新建脚本，粘贴 [`jisilu-qdiia-lof-estimate.user.js`](jisilu-qdiia-lof-estimate.user.js) 全文并保存。
3. 浏览器 **登录** [集思录](https://www.jisilu.cn/)（完整基金列表需登录）。
4. 打开 [https://www.jisilu.cn/data/qdii/#qdiia](https://www.jisilu.cn/data/qdii/#qdiia)，勾选「显示 LOF」等筛选后使用。
5. 点击表头 **实时溢价率** 可对本页排序（降序 → 升序 → 取消）。

---

## 技术说明

| 项目 | 说明 |
|------|------|
| 作用页面 | `#qdiia`，表格 `#flex_qdiia` |
| 数据来源 | 只读当前页 DOM（现价、净值、指数涨幅） |
| 刷新 | 跟随集思录「30 秒自动刷新」+ `MutationObserver` |
| 与官方 IOPV | 本脚本 **不含汇率、固定 95% 仓位**，与集思录官方估值/IOPV 可能不一致 |

---

## 开发与测试

```bash
node jisilu-qdiia-lof-calc.test.js
```

计算逻辑见 [`jisilu-qdiia-lof-calc.js`](jisilu-qdiia-lof-calc.js)（与脚本内公式一致）。

---

## 封号与合规

- 脚本 **不会** 复制 Cookie 去调用 `qdii_list` 等接口。
- 请勿同时运行对集思录 **高频抓包/爬虫** 的工具。
- 仅供学习研究，**不构成投资建议**；模型有误差，套利需自行核实申购赎回规则与风险。

---

## 文件

| 文件 | 说明 |
|------|------|
| `jisilu-qdiia-lof-estimate.user.js` | Tampermonkey 主脚本 |
| `jisilu-qdiia-lof-calc.js` | 计算模块 |
| `jisilu-qdiia-lof-calc.test.js` | 单元测试 |
