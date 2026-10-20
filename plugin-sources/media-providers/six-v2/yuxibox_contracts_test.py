import unittest
from yuxibox_contracts import video_documents, fields_for, expression, table


class YuxiboxExtractionTests(unittest.TestCase):
    def test_templates_conditionals_and_upload_alternatives(self):
        models, _ = video_documents()
        self.assertEqual(len(models),10)
        for model, document in models.items():
            fields, uploads = fields_for(document)
            self.assertIn('model',fields)
            self.assertTrue(fields['prompt']['required'])
            self.assertTrue(all('${' not in field.get('description','') for field in fields.values()))
            if document['kind']=='yx':
                for key, field in [('images','reference_images'),('videos','videos'),('audios','audios')]:
                    self.assertEqual(fields[field]['maxItems'],document['registry'][key],model)
                self.assertIn('input_reference',uploads)
            if document['kind']=='wan':
                self.assertEqual(fields['videos']['type'],'array')
                self.assertEqual(fields['videos']['maxItems'],5)
                self.assertEqual(fields['audios']['maxItems'],5)
                self.assertEqual(set(uploads),{'input_reference','images','videos','audios'})
            if document['kind']=='minimax':
                self.assertEqual(fields['reference_images']['maxItems'],9)
                self.assertFalse(fields['reference_images']['required'])
                self.assertEqual('requiredCondition' in fields['reference_images'],model!='minimax-h3-15s')
                self.assertEqual('1:1' in fields['ratio']['enum'],model!='minimax-h3-15s')

    def test_unsupported_expressions_fail_instead_of_losing_fields(self):
        with self.assertRaisesRegex(ValueError,'Unsupported documentation expression'):
            expression('fetch("https://invalid")',{})
        with self.assertRaisesRegex(ValueError,'Unknown documentation variable'):
            expression('`0–${unknown.limit}`',{})
        with self.assertRaises(ValueError): table('{name:"x",type:"string",required:newRequired(),description:"x"}',{})
        self.assertEqual(expression('"a"===d?`0–${t.limit}`:"no"',{'d':'a','t':{'limit':9}}),'0–9')


if __name__=='__main__': unittest.main()
