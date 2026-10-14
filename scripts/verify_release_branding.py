import hashlib,json,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
record_path=root/'dist/gravewright-savage-worlds-0.1.0.release.json'
record=json.loads(record_path.read_text(encoding='utf-8'))
notice='This game references the Savage Worlds game system, available from Pinnacle Entertainment Group at www.peginc.com. Savage Worlds and all associated logos and trademarks are copyrights of Pinnacle Entertainment Group. Used with permission. Pinnacle makes no representation or warranty as to the quality, viability, or suitability for purpose of this product.'
logo_sha='3a54347241721cff5891cde5a38cbfff54aeeb76257136b774948b81ccf9dd76'
for item in record['artifacts']:
    archive=root/'dist'/item['file']
    item['bytes']=archive.stat().st_size
    item['sha256']=hashlib.sha256(archive.read_bytes()).hexdigest()
    with zipfile.ZipFile(archive) as package:
        manifest=json.loads(package.read('manifest.json'))
        assert manifest['id']==item['id'] and manifest['version']=='0.1.0'
        assert notice in package.read('NOTICE.md').decode('utf-8')
        assert notice in package.read('README.md').decode('utf-8')
        if item['type']=='system':
            assert notice in package.read('README.pt-BR.md').decode('utf-8')
            assert hashlib.sha256(package.read('assets/branding/savage-worlds-logo.png')).hexdigest()==logo_sha
            assert manifest['name']=='Savage Worlds Compatibility Package for Gravewright'
        assert not any('Pasted text' in name or name.endswith('.pdf') for name in package.namelist())
    expected=archive.with_suffix('.zip.sha256').read_text(encoding='utf-8').split()[0]
    assert expected==item['sha256']
browser=next(item for item in record['artifacts'] if item['type']=='system')
for validation in record['validation'].values():
    if not isinstance(validation,dict) or 'report' not in validation:
        continue
    report=json.loads((root.parents[1]/validation['report']).read_text(encoding='utf-8'))
    assert report['passed'] and report['archiveSha256']==browser['sha256']
    validation['passed']=True
record['branding']={'publicName':'Savage Worlds Compatibility Package for Gravewright','exactPinnacleNotice':True,'logoSource':'https://peginc.com/wp-content/uploads/2019/01/SW_LOGO_FP_2018.png','originalLogoSha256':logo_sha,'trademarksExcludedFromMIT':True}
record_path.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'version':record['version'],'artifacts':record['artifacts'],'noticeVerified':True,'logoVerified':True},ensure_ascii=False))
