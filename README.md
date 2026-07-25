# 集思录 QDII 估值脚本（Tampermonkey）

本仓库包含 **两个** 油猴脚本，均只读当前页 DOM，不请求集思录 API。可按需分别安装。

| 脚本 | 页面 | 表格 |
|------|------|------|
| [`jisilu-qdiia-lof-estimate.user.js`](jisilu-qdiia-lof-estimate.user.js) | [亚洲市场 `#qdiia`](https://www.jisilu.cn/data/qdii/#qdiia) | `#flex_qdiia` |
| [`jisilu-qdiie-t1-estimate.user.js`](jisilu-qdiie-t1-estimate.user.js) | [欧美市场 `#qdiie`](https://www.jisilu.cn/data/qdii/#qdiie) | `#flex_qdiie`（欧美）、`#flex_qdiic`（商品） |

---

## 一、亚洲市场 · 实时估值（v1.4）

在表格中增加：

- **实时估值**（表头悬停：95% 仓位、无汇率）
- **实时溢价率**

**LOF / ETF** 同算法；**指数涨幅为 `-` / `--`** 时两列 **`-`**。

**净值日期 vs 会话日（v1.4）**：若 **净值日期 ≥ 当前会话日**（晚间已公布当日净值，或周末会话日回退到周五），**实时估值** 为 `-`，**实时溢价率** 为 `(现价 − 净值) / 净值`。否则：

```text
实时估值 = 净值 × (1 + 指数涨幅 × 95%)
实时溢价率 = (现价 − 实时估值) / 实时估值 × 100%
```

法定节假日未单独处理，与真实休市可能有偏差。

### 501305 验算

| 字段 | 值 |
|------|-----|
| 净值 | 1.2865 |
| 指数涨幅 | -0.47% |
| 实时估值 | ≈ 1.2808 |
| 现价 | 1.278 |
| 实时溢价率 | ≈ -0.22% |

### 安装与排查

1. Tampermonkey 新建脚本，粘贴 `jisilu-qdiia-lof-estimate.user.js` 并保存。
2. 登录集思录，打开 `#qdiia`；左下角 **「立即插入/刷新两列」**；Console 搜 `[集思录LOF估值]`。
3. 点击 **实时溢价率** 表头可排序。

---

## 二、欧美 / 商品 · T-1 日估值（v1.0）

同一 URL `#qdiie` 下 **两个表** 都会插列（欧美 + 商品）。

- **T-1日估值**
- **T-1日估值溢价率**

```text
T-1日估值 = T-2净值 × (1 + T-1指数涨幅 × 95%)
T-1日估值溢价率 = (现价 − T-1日估值) / T-1日估值 × 100%
```

| 表格 | 净值列 | 指数列 |
|------|--------|--------|
| 欧美 `#flex_qdiie` | T-2净值 | T-1指数涨幅 |
| 商品 `#flex_qdiic` | T-2净值 | **参考标的期间涨幅**（非会员多为 `-` → 两列 `-`） |

第一版 **不含** 亚洲脚本那种「净值日期 / 会话日停估」逻辑。

### 安装

1. Tampermonkey 再建 **第二个** 脚本，粘贴 `jisilu-qdiie-t1-estimate.user.js`。
2. 打开 `#qdiie`；左下角 **`jsl-qdiie-t1-status`** 面板；Console 搜 `[集思录T-1估值]`。
3. 可与亚洲脚本 **同时安装**（DOM 标记与面板 ID 不同）。

---

## 开发与测试

```bash
node jisilu-qdiia-lof-calc.test.js
node jisilu-qdiie-t1-calc.test.js
```

| 文件 | 说明 |
|------|------|
| `jisilu-qdiia-lof-estimate.user.js` | 亚洲市场 Tampermonkey |
| `jisilu-qdiia-lof-calc.js` / `*.test.js` | 亚洲计算与单测 |
| `jisilu-qdiie-t1-estimate.user.js` | 欧美/商品 Tampermonkey |
| `jisilu-qdiie-t1-calc.js` / `*.test.js` | T-1 计算与单测 |

---

## 通用说明

| 项目 | 说明 |
|------|------|
| 仓位 / 汇率 | 固定 **95%**，**不含汇率**；与集思录官方 IOPV / T-1 估值可能不一致 |
| 刷新 | 轮询 + `MutationObserver`；非会员可用手动刷新按钮 |
| 合规 | 勿配合高频爬虫；**不构成投资建议** |
