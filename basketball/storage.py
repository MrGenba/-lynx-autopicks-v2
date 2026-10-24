"""Basketball has its own REST database; never redirect the baseball environment."""
import os


def rest_config():
    url = os.environ.get('BASKETBALL_REST_URL')
    key = os.environ.get('BASKETBALL_REST_KEY')
    if bool(url) != bool(key):
        raise RuntimeError('BASKETBALL_STORAGE_CONFIG_INCOMPLETE')
    if not url:
        url = os.environ['SUPABASE_URL'].rstrip('/') + '/rest/v1'
        key = os.environ['SUPABASE_KEY']
    return url.rstrip('/') + '/', {'apikey': key, 'Authorization': 'Bearer ' + key}
