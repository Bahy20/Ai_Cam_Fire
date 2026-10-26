import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeInvestigation, suppressionAdvice } from '../src/investigation.js';

test('shared wire fixtures agree and only JS policy can authorize an agent', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../test_fixtures/investigation.json', import.meta.url)));
  for (const fixture of fixtures) {
    const r = normalizeInvestigation(fixture.input);
    for (const [key, value] of Object.entries(fixture.common)) assert.deepEqual(r[key], value, `${fixture.name}: ${key}`);
    assert.equal(r.recommended_agent, 'undetermined');
    assert.equal(suppressionAdvice(r).recommended_agent, fixture.policy_agent, fixture.name);
  }
});

const ordinary = { fuel_type: 'dry_organic', evidence_status: 'observed', confidence: 'high',
  electrical_hazard: 'absent', incompatible_fuel_hazard: 'absent' };

test('deterministic suppression truth table is deny-first', () => {
  for (const [input, agent, cls] of [
    [{}, 'undetermined', 'unknown'],
    [ordinary, 'water_or_soil_sand', 'A'],
    [{ ...ordinary, fuel_type: 'wood_paper' }, 'water_or_soil_sand', 'A'],
    [{ ...ordinary, fuel_type: 'cooking_oil' }, 'wet_chemical', 'F_K'],
    [{ ...ordinary, fuel_type: 'metal' }, 'specialist_required', 'D'],
    [{ ...ordinary, fuel_type: 'flammable_liquid' }, 'specialist_required', 'B'],
    [{ ...ordinary, fuel_type: 'gas' }, 'specialist_required', 'B'],
    [{ ...ordinary, electrical_hazard: 'present' }, 'specialist_required', 'unknown'],
    [{ ...ordinary, electrical_hazard: 'unknown' }, 'undetermined', 'unknown'],
    [{ ...ordinary, incompatible_fuel_hazard: 'unknown' }, 'undetermined', 'unknown'],
    [{ ...ordinary, incompatible_fuel_hazard: 'present' }, 'undetermined', 'unknown'],
    [{ ...ordinary, fuel_type: ['wood_paper', 'cooking_oil'] }, 'undetermined', 'unknown'],
    [{ ...ordinary, fire_class: 'F_K' }, 'undetermined', 'unknown'],
    [{ ...ordinary, evidence_status: 'inferred' }, 'undetermined', 'unknown'],
    [{ ...ordinary, reasons: 42 }, 'undetermined', 'unknown'],
  ]) {
    const r = suppressionAdvice(normalizeInvestigation(input));
    assert.equal(r.recommended_agent, agent, JSON.stringify(input));
    assert.equal(r.fire_class, cls, JSON.stringify(input));
    assert.equal(r.advisory_only, true);
  }
  assert.equal(suppressionAdvice(normalizeInvestigation({recommended_agent: 'water_or_soil_sand'})).recommended_agent, 'undetermined');
});

test('ignition source owns the causal alias across all wire values and omissions', () => {
  for (const source of [undefined, 'unknown', 'human', 'spark', 'electrical']) {
    for (const alias of [undefined, 'unknown', 'human', 'spark', 'electrical']) {
      const input = { ...ordinary };
      if (source !== undefined) input.ignition_source = source;
      if (alias !== undefined) input.probable_cause = alias;
      const label = JSON.stringify(input);
      const canonicalSource = source ?? 'unknown';
      const conflict = alias !== undefined && alias !== 'unknown' && alias !== canonicalSource;
      const r = normalizeInvestigation(input);
      assert.equal(r.ignition_source, canonicalSource, label);
      assert.equal(r.probable_cause, canonicalSource, label);
      assert.deepEqual(r.validation_errors, conflict ? ['probable_cause: contradicts ignition_source'] : [], label);
      assert.equal(r.confidence, conflict ? 'low' : 'high', label);
      assert.equal(suppressionAdvice(r).recommended_agent, conflict ? 'undetermined' : 'water_or_soil_sand', label);
      assert.deepEqual(normalizeInvestigation(r), r, `revalidation: ${label}`);
    }
  }
});

test('invalid model-agent enum is rejected even though it has no authority', () => {
  const r = normalizeInvestigation({...ordinary, recommended_agent: 'water (bucket)'});
  assert.equal(r.recommended_agent, 'undetermined');
  assert.equal(r.confidence, 'low');
  assert.ok(r.validation_errors.includes('recommended_agent: invalid enum'));
  assert.equal(suppressionAdvice(r).recommended_agent, 'undetermined');
});

test('revalidation retains bounded upstream diagnostics and cannot erase a failure', () => {
  const first = normalizeInvestigation({fuel_type: ['wood_paper'], confidence: 'high'});
  const second = normalizeInvestigation(first);
  assert.deepEqual(second.validation_errors, first.validation_errors);
  assert.equal(second.confidence, 'low');
  const wire = normalizeInvestigation({...ordinary, validation_errors: ['invalid upstream schema']});
  assert.equal(wire.confidence, 'low');
  assert.equal(suppressionAdvice(wire).recommended_agent, 'undetermined');
});

test('unsupported certainty is downgraded when evidence or attribution is unknown', () => {
  for (const input of [{confidence: 'high'}, {ignition_source: 'human', confidence: 'medium'},
    {evidence_status: 'observed', ignition_tool: 'lighter', confidence: 'high'}]) {
    const r = normalizeInvestigation(input);
    assert.equal(r.confidence, 'low');
    assert.ok(r.validation_errors.includes('confidence: unsupported certainty'));
  }
});

test('empty investigation never recommends water', () => {
  const r = normalizeInvestigation({});
  assert.equal(r.fuel_type, 'unknown');
  assert.equal(r.fire_class, 'unknown');
  assert.equal(r.recommended_agent, 'undetermined');
  assert.equal(r.confidence, 'low');
});

test('schema rejects invalid types/enums and never copies arbitrary keys', () => {
  for (const input of [null, [], 'water', { ignition_source: 'arson' },
    { confidence: 0.9 }, { reasons: 'person with lighter' }, { fuel_type: ['wood_paper'] }]) {
    const r = normalizeInvestigation(input);
    assert.equal(r.confidence, 'low');
    assert.ok(r.validation_errors.length > 0, JSON.stringify(input));
    assert.equal(r.recommended_agent, 'undetermined');
  }
  const r = normalizeInvestigation({ ignition_source: 'human', evidence_status: 'inferred',
    confidence: 'medium', evidence: ['action not visible'], injected: true });
  assert.equal(r.ignition_source, 'human');
  assert.equal(r.ignition_tool, 'unknown');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.injected, undefined);
});

test('evidence strings and arrays are bounded and truncation downgrades confidence', () => {
  const r = normalizeInvestigation({ confidence: 'high',
    reasons: Array(10).fill('x'.repeat(400)), evidence: ['ok', 42] });
  assert.equal(r.reasons.length, 8);
  assert.ok(r.reasons.every(s => s.length === 300));
  assert.deepEqual(r.evidence, ['ok']);
  assert.equal(r.confidence, 'low');
  assert.ok(r.validation_errors.length > 0);
});
