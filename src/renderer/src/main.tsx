import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './main.css'
import { applyFontTheme, loadFontTheme } from './lib/font-theme'
import { applyTheme, loadTheme } from './lib/theme'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

/*
 * 主题和字体都在**首帧之前**应用，而不是等 App 里某个 effect。
 *
 * 等 effect 的话会先按默认值画一帧、再换掉，用户能看见一次明显的闪烁
 * ——换了主题之后尤其刺眼（底色从白跳到粉紫）。
 * 这里在 render 之前把属性挂到 `<html>` 上，第一帧就是最终效果。
 */
applyTheme(loadTheme(), document.documentElement)
applyFontTheme(loadFontTheme(), document.documentElement)

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
