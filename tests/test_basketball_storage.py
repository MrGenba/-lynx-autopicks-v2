import os,unittest
from unittest.mock import patch
from basketball.storage import rest_config

class StorageTest(unittest.TestCase):
    def test_independent_store_does_not_mutate_baseball(self):
        env={'BASKETBALL_REST_URL':'https://basketball.example/','BASKETBALL_REST_KEY':'basketball-secret','SUPABASE_URL':'https://baseball.example','SUPABASE_KEY':'baseball-secret'}
        with patch.dict(os.environ,env,clear=True):
            url,headers=rest_config()
            self.assertEqual(url,'https://basketball.example/')
            self.assertEqual(headers['Authorization'],'Bearer basketball-secret')
            self.assertEqual(os.environ['SUPABASE_KEY'],'baseball-secret')
    def test_partial_configuration_fails_instead_of_leaking_writes_back_to_baseball(self):
        with patch.dict(os.environ,{'BASKETBALL_REST_URL':'https://basketball.example','SUPABASE_URL':'https://baseball.example','SUPABASE_KEY':'secret'},clear=True):
            with self.assertRaisesRegex(RuntimeError,'CONFIG_INCOMPLETE'):rest_config()

if __name__=='__main__':unittest.main()
