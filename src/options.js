'use strict'
/**
 * Shared option fields: the composition picker. The dropdown is filled from
 * the status feed's composition list and the catalog (TCP get:complist); the
 * text field is the fallback (an engine without the feed, a composition added
 * after the button was made, a variable). Text wins when it is not empty.
 */

function compositionOptions(choices) {
	return [
		{
			type: 'dropdown',
			id: 'comp',
			label: 'Composition',
			choices,
			default: choices.length ? choices[0].id : '',
			allowCustom: true,
		},
		{
			type: 'textinput',
			id: 'compText',
			label: 'or composition ID / name (overrides the list; variables allowed)',
			default: '',
			useVariables: true,
		},
	]
}

/** Resolve the composition reference from an action's/feedback's options. */
async function resolveComposition(options, context) {
	const text = typeof options.compText === 'string' ? options.compText.trim() : ''
	if (text) {
		const parsed = context && context.parseVariablesInString ? await context.parseVariablesInString(text) : text
		return String(parsed).trim()
	}
	return typeof options.comp === 'string' ? options.comp.trim() : String(options.comp ?? '').trim()
}

/** A text option with variables, parsed; never throws. */
async function parsedText(options, id, context) {
	const raw = options[id] === undefined || options[id] === null ? '' : String(options[id])
	if (!raw) return ''
	return context && context.parseVariablesInString ? String(await context.parseVariablesInString(raw)) : raw
}

/** A number option given as text with variables → number or undefined. */
async function parsedNumber(options, id, context) {
	const t = (await parsedText(options, id, context)).trim()
	if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined
	return Number(t)
}

module.exports = { compositionOptions, resolveComposition, parsedText, parsedNumber }
