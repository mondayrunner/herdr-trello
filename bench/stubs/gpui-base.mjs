import { element, count } from "./counter.mjs";

export const v_flex = () => element();
export const h_flex = () => element();

const state = () => ({ on() {}, value: () => "", set_value() {}, set_auto_grow() {} });
export const InputState = { new: state };
export const TextareaState = { new: state };
export const Input = { new: () => element() };
export const Textarea = { new: () => element() };
export const TextView = { markdown: (_id, text) => { count.texts.push(text); return element(); } };
