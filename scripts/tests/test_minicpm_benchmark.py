import unittest
from analysis.minicpm_benchmark import parse_assessment, category_for

class AssessmentTests(unittest.TestCase):
    def assessment(self,**changes):
        return dict(flame='not_observed',smoke='not_observed',burning_material='not_observed',
                    lighter='not_observed',flame_relation='not_observed',description='A desk with a computer mouse.',**changes)

    def test_absence_is_explicit_and_uncertainty_is_not_absence(self):
        value=self.assessment()
        self.assertEqual(category_for(parse_assessment(value)),'no_visible_fire')
        value['flame']='uncertain';self.assertEqual(category_for(parse_assessment(value)),'uncertain')

    def test_burning_and_smoke_override_lighter(self):
        value=self.assessment();value.update(flame='present',lighter='present',flame_relation='at_tool_tip')
        self.assertEqual(category_for(parse_assessment(value)),'contained_lighter_candidate')
        value['burning_material']='present';self.assertEqual(category_for(parse_assessment(value)),'material_burning')
        value['smoke']='present';value['burning_material']='not_observed'
        self.assertEqual(category_for(parse_assessment(value)),'smoke')

    def test_malformed_output_never_becomes_a_negative(self):
        import json
        for value in ('partial {','{}',json.dumps(self.assessment())[:-1]):
            with self.assertRaises(ValueError):parse_assessment(value)
        for change in ({'flame':'none'},{'priority':'safe'},{'description':''},{'flame_relation':'at_tool_tip'},
                       {'flame_relation':'separate'},{'flame':[]},{'flame':{'value':'present'}}):
            value=self.assessment();value.update(change)
            with self.assertRaises(ValueError):parse_assessment(value)

    def test_duplicate_json_fields_are_not_a_negative(self):
        import json
        raw=json.dumps(self.assessment()).replace('"flame": "not_observed"','"flame": "present", "flame": "not_observed"')
        with self.assertRaises(ValueError):parse_assessment(raw)

if __name__=='__main__':unittest.main()
