import unittest,json
from analysis.minicpm_contract import parse_frames,build_prompt

class MiniCPMContractTests(unittest.TestCase):
    def test_unrequested_view_quality_is_rejected_not_mapped_to_occlusion(self):
        from analysis.minicpm_contract import parse_batch,single_image_prompt
        row={'flame':'not_observed','smoke':'not_observed','burning_material':'not_observed','lighter':'not_observed',
             'flame_relation':'not_observed','occlusion':'not_observed','description':'Visible objects, no plume.'}
        self.assertEqual(parse_batch([json.dumps(row)],['source'])['frames'][0],{**row,'frame_id':'source'})
        self.assertIn('"occlusion"',single_image_prompt());self.assertNotIn('view_quality',single_image_prompt())
        without_occlusion={k:v for k,v in row.items() if k!='occlusion'}
        for invalid in [{**without_occlusion,'view_quality':quality} for quality in ('assessable','obstructed','uncertain')]+[
            {**row,'view_quality':'assessable'},{**row,'view_quality':'safe'},without_occlusion]:
            with self.assertRaisesRegex(ValueError,'minicpm_invalid'):parse_batch([json.dumps(invalid)],['source'])
        with self.assertRaisesRegex(ValueError,'minicpm_invalid_single_frame'):parse_batch([json.dumps({**without_occlusion,'view_quality':'assessable'})],['source'])
    def test_exact_frames_and_contradictions(self):
        row={'frame_id':'frame-1','flame':'not_observed','smoke':'not_observed','burning_material':'not_observed',
             'lighter':'not_observed','flame_relation':'not_observed','occlusion':'uncertain','description':'A room.'}
        self.assertEqual(parse_frames(json.dumps({'frames':[row]}),['frame-1']),{'frames':[row]})
        wrapped='```json\n'+json.dumps({'frames':[row]})+'\n```'
        self.assertEqual(parse_frames(wrapped,['frame-1']),{'frames':[row]})
        for raw in ['{"frames":[],"frames":[]}',json.dumps({'frames':[{**row,'flame_relation':'at_tool_tip'}]}),
                    json.dumps({'frames':[{**row,'frame_id':'foreign'}]})]:
            with self.assertRaises(ValueError):parse_frames(raw,['frame-1'])
        prompt=build_prompt(['frame-1'])
        self.assertIn('frame-1',prompt);self.assertIn('occlusion',prompt)

    def test_timed_out_remote_input_is_cancelled(self):
        from unittest.mock import Mock
        from analysis.minicpm_client import invoke
        model=Mock();call=model.analyze.spawn.return_value
        call.get.side_effect=TimeoutError('deadline')
        with self.assertRaises(TimeoutError):invoke(model,'analyze',[],1)
        call.cancel.assert_called_once()

    def test_independent_batch_outputs_cannot_be_copied_to_other_images(self):
        from analysis.minicpm_contract import parse_batch
        row={'frame_id':'frame-1','flame':'not_observed','smoke':'not_observed','burning_material':'not_observed',
             'lighter':'not_observed','flame_relation':'not_observed','occlusion':'uncertain','description':'A room.'}
        raws=[json.dumps({k:v for k,v in {**row,'description':description}.items() if k!='frame_id'}) for description in ['Room one.','Room two.']]
        values=parse_batch(raws,['frame-1','frame-2'])['frames']
        self.assertEqual([r['frame_id'] for r in values],['frame-1','frame-2'])
        self.assertEqual([r['description'] for r in values],['Room one.','Room two.'])
        with self.assertRaises(ValueError):parse_batch(raws[:1],['frame-1','frame-2'])
        with self.assertRaises(ValueError):parse_batch([json.dumps(row)],['frame-2'])

if __name__=='__main__':unittest.main()
