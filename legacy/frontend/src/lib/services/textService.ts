import type Quill from 'quill';

/**
 * 将Quill的Delta转换为Bubblefish文本格式
 * @param quill - Quill实例
 * @returns 转换后的Bubblefish格式文本
 */
export function quillDelta2bubblefishText(quill: Quill): string {
	const delta = quill.getContents();
	let text = '';
	
	delta.ops?.forEach((op) => {
		if (typeof op.insert === 'string') {
			let content = op.insert;
			// 收集所有格式
			const formats = [];
			if (op.attributes?.bold) {
				formats.push('\\加粗');
			}
			if (op.attributes?.italic) {
				formats.push('\\斜体');
			}
			if (op.attributes?.strike) {
				formats.push('\\划掉');
			}
			if (op.attributes?.emphasis) {
				formats.push('\\重点');
			}
			
			// 如果有任何格式，包装成[text](formats)格式
			if (formats.length > 0) {
				content = `[${content}](${formats.join('')})`;
			}
			text += content;
		}
	});
	
	// 移除末尾的换行符
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * 将Bubblefish文本格式转换为Quill的Delta格式
 * @param text - Bubblefish格式的文本
 * @returns Quill Delta操作数组
 */
export function bubblefishText2quillDelta(text: string) {
	const ops: Array<{ insert: string; attributes?: { bold?: boolean; italic?: boolean; strike?: boolean; emphasis?: boolean } }> = [];
	// 使用正则匹配各种格式文本 [text](\\格式)
	const formatRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
	let lastIndex = 0;
	let match;

	while ((match = formatRegex.exec(text)) !== null) {
		// 添加格式前的普通文本
		if (match.index > lastIndex) {
			ops.push({ insert: text.slice(lastIndex, match.index) });
		}
		
		// 解析格式
		const content = match[1];
		const format = match[2];
		const attributes: { bold?: boolean; italic?: boolean; strike?: boolean; emphasis?: boolean } = {};
		
		if (format.includes('\\加粗')) {
			attributes.bold = true;
		}
		if (format.includes('\\斜体')) {
			attributes.italic = true;
		}
		if (format.includes('\\划掉')) {
			attributes.strike = true;
		}
		if (format.includes('\\重点')) {
			attributes.emphasis = true;
		}
		
		// 添加格式化文本
		ops.push({ insert: content, attributes });
		lastIndex = match.index + match[0].length;
	}

	// 添加剩余的普通文本
	if (lastIndex < text.length) {
		ops.push({ insert: text.slice(lastIndex) });
	}

	return ops;
}