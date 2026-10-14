import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
MESSAGES=json.loads(r'''{"en":{"permission.about":"About","permission.scope":"Free compatibility package with character sheets, rolls, card tools and user-entered data. Uses the permitted Fan Product logo.","permission.officialRules":"Official Savage Worlds rules"},"pt-BR":{"permission.about":"Sobre","permission.scope":"Pacote gratuito de compatibilidade com fichas, rolagens, cartas e dados preenchidos pelo usuário. Usa o logo Fan Product autorizado.","permission.officialRules":"Regras oficiais de Savage Worlds"},"es":{"permission.about":"Acerca de","permission.scope":"Paquete gratuito de compatibilidad con fichas, tiradas, cartas y datos del usuario. Usa el logotipo Fan Product permitido.","permission.officialRules":"Reglas oficiales de Savage Worlds"}}''')
for locale, additions in MESSAGES.items():
    path=ROOT/'locales'/f'{locale}.json'
    values=json.loads(path.read_text(encoding='utf-8-sig'))
    for key, value in additions.items():
        values.setdefault(key, value)
    path.write_text(json.dumps(values,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
