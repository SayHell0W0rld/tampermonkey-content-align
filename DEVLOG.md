# 开发记录 (DEVLOG)

## 项目信息

- **项目位置**: `~/projects/content-align/`
- **技术栈**: 纯 JavaScript 油猴脚本（无依赖）
- **目标浏览器**: Chrome/Edge (Tampermonkey)、Firefox (Tampermonkey/Violentmonkey)
- **开发方式**: Hermes Agent 直接编写（非 Claude Code 委派）

## 需求背景

用户长时间面对电脑，网页默认左对齐导致身体不自觉左倾。需要一个工具让网页内容居中或右移，保持正中坐姿。

## 开发历程

### Phase 8: 中文仿生阅读 + 视觉优化 (v15)
- **中文仿生阅读重写**：基于眼动追踪研究（Li et al., 2011），中文阅读注视点在词首，每词仅加粗首字
- **font-weight: 900 替代 bold**：粗体对复杂汉字（CJK）会变成"一团黑"，更重的字重反而更清晰
- **仿生阅读可配置**：注视强度（fixation multiplier）、跳词间隔（saccades）、非加粗渐隐（fade）
- **磨砂玻璃虚化**：blur(12px) + brightness(0.4) + saturate(0.3)，纯 filter 实现
- **mousemove 节流**：30ms throttle 防止聚焦/跟踪模式高频重绘闪烁
- **阅读按钮角标**：多模式时显示 📖 + 红色数字 badge，避免 emoji 堆叠溢出

### Phase 7: 阅读辅助优化 (v14)
- 移除行聚焦（效果差、易冲突），新增段落彩条（zebra striping）
- 仿生阅读支持中文：CJK 字符检测 + 标点切分，中文短语首字加粗
- 阅读辅助改为可叠加模式（Set 存储），非互斥
- 按钮图标动态显示已开启模式的组合

### Phase 6:  阅读辅助 (v13-v13.1)
- 独立于内容对齐的第二套系统
- v13: 左下角独立按钮 + 油猴菜单
- v13.1: 改为悬停展开——鼠标悬停主按钮时，阅读辅助小按钮从下方淡出
- 两套系统可叠加使用（如：内容聚焦 + 仿生阅读同时开启）

### Phase 1: 基础功能 (v1-v3)
- v1: 文本居中/右对齐（CSS text-align + margin auto）
- v2: 尝试布局反转（Flex row-reverse / Grid / CSS order）
- v3: 发现布局反转在实际网页中不可靠（嵌套 flex/grid/float 混用），改用 `body transform: translateX` 平移

**教训**: CSS 布局反转在生产网页上翻车率极高，不同网站结构差异太大。

### Phase 2: 按钮交互优化 (v4-v6)
- v4: 修复按钮跟随 body transform 移动（挂载到 documentElement）、滚动条（overflow-x: hidden）、鼠标跟踪
- v5: 5 种模式，聚焦（实时跟踪）和跟踪（锁定）
- v6: 按钮从循环切换改为弹出菜单，显示当前模式

### Phase 3: 聚焦/跟踪重新定义 (v7-v8)
- v7: 修复菜单在右移模式下消失、tooltip 不更新、elementFromPoint 在 transform 后不准确
- v8: 重新定义聚焦（纯虚化）vs 跟踪（虚化+居中锁定+双击解锁）

### Phase 4: 区块检测算法 (v9-v10)
- v9: "找最大面积祖先"算法 → 总是返回整个页面，完全失效
- v10: 重写为"父容器有 2-6 个显著子元素"的启发式算法

**教训**: "最大面积"策略在任何页面都会返回 body 或页面 wrapper，没有意义。正确思路是找"有意义的同级兄弟数量"。

### Phase 5: 交互细节打磨 (v11-v12)
- v11: 聚焦改为虚化+居中（后在 v12 回退）
- v12: 恢复聚焦为纯虚化，跟踪增加延迟锁定（300ms）、蓝色高亮预览、点击拦截器、暗色蒙版
- v12.3: 居中区块保留原始背景、修复链接点击、清理所有 inline style

## 关键技术决策

### 1. 按钮挂载位置
**决策**: 挂载到 `document.documentElement` 而非 `document.body`
**原因**: `body` 的 `transform` 会改变 `fixed` 定位的参考系，导致按钮跟着移走

### 2. 菜单挂载位置
**决策**: 同样挂载到 `document.documentElement`
**原因**: 同上，右移模式下菜单不应跟着 body 移动

### 3. elementFromPoint 查询
**决策**: 查询前临时去掉所有 `data-ca-managed` 元素的 `transform: none`
**原因**: transform 后的元素可能导致 `elementFromPoint` 返回错误的最深层元素

### 4. 区块检测启发式
**决策**: 找父容器有 2-6 个显著子元素的层级
**依据**: 现代网页布局（Holy Grail、博客、视频网格）中，内容区块通常是 2-6 个同级兄弟之一

### 5. 点击拦截
**决策**: 跟踪模式下拦截虚化区域的 click，放行居中区块的 click
**原因**: 防止用户误触虚化区域的链接跳转，同时不影响居中内容的交互

### 6. 延迟锁定
**决策**: 300ms 延迟后才锁定居中
**原因**: 防止鼠标快速划过时误锁

### 7. 按钮位置
**决策**: `right: 36px`，紧贴滚动条左侧
**原因**: 滚动条宽约 15-17px，按钮 40px 宽，`right: 36px` 让按钮左侧紧贴滚动条边缘

### 8. 中文仿生阅读算法
**原因**: 中文在虚词后切分，每语义单元首字加粗，用 font-weight: 900
**原因**: 
- 眼动追踪研究显示中文阅读注视点在词首（非词中如英文）
- 每个汉字是完整语义单元，首字提供最强识别锚点
- 粗体对笔画复杂的汉字反而降低可读性（Raymond Chen/Microsoft 指出）
- 感知跨度仅 3-4 字，加粗首字已足够引导视线
**参考**: Li, Liu & Rayner (2011) PMC3119713; Pan et al. (2024)

### 9. 磨砂玻璃替代灰黑蒙版
**决策**: blur(12px) + brightness + saturate + ::after 半透明遮罩
**原因**: 旧方案的 rgba(0,0,0,0.5) 蒙版太丑，磨砂玻璃既遮挡内容又保留轮廓感
**注意**: 不能用 ::after 伪元素加半透明遮罩

#### 12. 配置面板 capture 阶段竞态
**问题**: closeAllOutside 用 capture:true 在捕获阶段先于 ⚙️ click 执行，把 read menu 关掉
**修复**: closeAllOutside 开头检查 e.target.textContent === '⚙' 则跳过

### 10. mousemove 节流
**决策**: 30ms throttle（~33fps）
**原因**: 聚焦/跟踪模式每帧都 clearManaged + dimSiblings，高频 DOM 操作导致闪烁，对光敏性人群可能造成不适

## 已知限制

1. **布局反转不可靠**: CSS 层面无法可靠反转网页布局结构（v2-v3 已验证）
2. **区块检测依赖 DOM 结构**: 语义化 HTML（main/article/nav）检测更准确，大量 div 嵌套的页面可能不理想
3. **SPA 重新应用有延迟**: MutationObserver 检测 URL 变化后有 500ms 延迟
4. **中文分词精度**: 当前用标点切分替代真实分词（jieba 等），精度有限但无外部依赖

## 为后续项目维护的规范

### 每步记录原则
- 每次功能变更或 bug 修复，更新 README.md 的更新记录
- 重大技术决策记录到 DEVLOG.md
- 代码中关键逻辑加中文注释

### 文件结构
```
project/
├── README.md          用户文档 + 更新记录
├── DEVLOG.md          开发过程记录
├── 源代码文件
└── docs/              其他文档（如有）
```
