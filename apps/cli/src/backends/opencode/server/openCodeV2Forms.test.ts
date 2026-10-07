import { describe, expect, it } from 'vitest';

import { buildOpenCodeV2FormAnswer, projectOpenCodeV2Form } from './openCodeV2Forms';

/**
 * Owner tests for the released V2 form seam (tag v2.0.15). Upstream `Form.Option.value/label`
 * are opaque strings: whitespace and empty are valid and must survive verbatim. `when.key`
 * references an earlier field, so conditional evaluation follows declaration order even when a
 * hidden default depends on an earlier visible answer. `custom: true` alongside options is the
 * released freeform escape hatch and maps onto AskUserQuestion `freeform`, not a dropped field.
 */
describe('openCodeV2Forms released contract', () => {
  it('preserves exact whitespace option values instead of treating them as unanswered', () => {
    const projection = projectOpenCodeV2Form({
      id: 'frm_1',
      sessionID: 'ses_1',
      title: 'T',
      fields: [{ key: 'k', type: 'string', title: 'K', options: [{ value: '  ', label: 'Whitespace value' }] }],
    });
    expect(projection).not.toBeNull();
    const answer = buildOpenCodeV2FormAnswer(projection!.bindings, [['Whitespace value']], projection!.hiddenBindings);
    expect(answer).toEqual({ k: '  ' });
  });

  it('evaluates a hidden conditional default after the earlier visible field it depends on', () => {
    const projection = projectOpenCodeV2Form({
      id: 'frm_1',
      sessionID: 'ses_1',
      title: 'T',
      fields: [
        { key: 'mode', type: 'string', title: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
        { key: 'detail', type: 'string', title: 'Detail', default: 'dflt', hidden: true, when: [{ key: 'mode', op: 'eq', value: 'a' }] },
      ],
    });
    expect(projection).not.toBeNull();
    const answer = buildOpenCodeV2FormAnswer(projection!.bindings, [['A']], projection!.hiddenBindings);
    expect(answer).toEqual({ mode: 'a', detail: 'dflt' });
  });

  it('preserves exact field and condition keys without prototype-key loss', () => {
    const projection = projectOpenCodeV2Form({
      id: 'frm_1',
      sessionID: 'ses_1',
      title: 'T',
      fields: [
        { key: ' mode ', type: 'string', title: 'Mode', options: [{ value: 'a', label: 'A' }] },
        {
          key: '__proto__',
          type: 'multiselect',
          title: 'Reserved key',
          options: [{ value: 'x', label: 'X' }],
          default: ['x'],
          hidden: true,
          when: [{ key: ' mode ', op: 'eq', value: 'a' }],
        },
      ],
    });
    expect(projection).not.toBeNull();
    const answer = buildOpenCodeV2FormAnswer(projection!.bindings, [['A']], projection!.hiddenBindings);
    expect(Object.getPrototypeOf(answer)).toBeNull();
    expect(Object.keys(answer)).toEqual([' mode ', '__proto__']);
    expect(answer[' mode ']).toBe('a');
    expect(answer.__proto__).toEqual(['x']);
  });

  it('projects custom-with-options as options plus freeform instead of unrepresentable', () => {
    const projection = projectOpenCodeV2Form({
      id: 'frm_1',
      sessionID: 'ses_1',
      title: 'T',
      fields: [{ key: 'k', type: 'string', title: 'K', options: [{ value: 'a', label: 'A' }], custom: true }],
    });
    expect(projection).not.toBeNull();
    expect(projection!.unrepresentable).toEqual([]);
    const question = projection!.request.questions[0] as Record<string, unknown>;
    expect(question.freeform).toEqual({});
    const answer = buildOpenCodeV2FormAnswer(projection!.bindings, [['typed-beyond-options']], projection!.hiddenBindings);
    expect(answer).toEqual({ k: 'typed-beyond-options' });
  });
});
