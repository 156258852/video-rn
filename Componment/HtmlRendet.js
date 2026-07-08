import {useCallback, memo} from 'react';
import classnames from 'classnames';

/**
 * HtmlRenderer - 渲染 HTML 字符串，拦截 <a> 标签点击事件
 *
 * @param {string}   html        - 要渲染的 HTML 字符串
 * @param {Function} onLinkClick - 链接点击回调，参数: (href, text, event)
 * @param {string}   className   - 容器自定义 class
 * @param {object}   style       - 容器自定义样式
 */
function HtmlRenderer({html = '', onLinkClick, className = '', style}) {
  const handleClick = useCallback(
    e => {
      const anchor = e.target.closest('a');
      // 仅处理容器内的链接，避免匹配到外层祖先 <a>
      if (!anchor || !e.currentTarget.contains(anchor)) {
        return;
      }

      // 仅在提供回调时拦截默认跳转；否则保持原生链接行为
      if (!onLinkClick) {
        return;
      }
      e.preventDefault();
      onLinkClick(anchor.getAttribute('href'), anchor.textContent, e);
    },
    [onLinkClick],
  );

  return (
    <div
      className={classnames('html-renderer', className)}
      style={style}
      onClick={handleClick}
      dangerouslySetInnerHTML={{__html: html}}
    />
  );
}

export default memo(HtmlRenderer);
