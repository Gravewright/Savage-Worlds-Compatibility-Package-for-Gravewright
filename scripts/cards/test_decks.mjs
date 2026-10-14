import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {cardSpecs,pipLayout,WIDTH,HEIGHT,THEMES} from './renderer.mjs';
import {parseCard} from '../../initiative.js';

const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cataloguePath=path.join(packageRoot,'assets/action-decks/catalogue.json');
const readJson=async file=>JSON.parse(await readFile(file,'utf8'));

test('original deck specifications contain all 52 pairs and distinct native-compatible jokers',()=>{
  const specs=cardSpecs();assert.equal(specs.length,54);
  assert.equal(new Set(specs.map(c=>c.name)).size,54);
  const scores=specs.map(c=>parseCard(c.name).score);assert.equal(new Set(scores).size,54);
  for(let score=1;score<=52;score++)assert.ok(scores.includes(score));
  assert.ok(scores.includes(60));assert.ok(scores.includes(61));
});

test('each numeric face has exactly its rank in distinct central pip positions, separate from indices',()=>{
  for(let rank=2;rank<=10;rank++){
    const pips=pipLayout(String(rank));assert.equal(pips.length,rank);
    assert.equal(new Set(pips.map(p=>`${p.x},${p.y}`)).size,rank);
    for(const p of pips){assert.ok(p.x>130&&p.x<470);assert.ok(p.y>180&&p.y<720);assert.equal(p.angle,p.y>450?Math.PI:0);}
  }
  assert.deepEqual(pipLayout('7').reduce((rows,p)=>(rows[p.y]=(rows[p.y]??0)+1,rows),{}),{240:2,450:3,660:2});
  assert.throws(()=>pipLayout('J'));assert.throws(()=>pipLayout('1'));
});

test('catalogue is complete, asset paths remain inside the package and images satisfy native file limits',async()=>{
  const catalogue=await readJson(cataloguePath);assert.equal(catalogue.schemaVersion,1);
  assert.deepEqual(catalogue.themes.map(t=>t.id),Object.keys(THEMES));
  const specifications=cardSpecs();
  for(const theme of catalogue.themes){
    assert.equal(theme.titleKey,`settings.deck.${theme.id}.title`);assert.equal(theme.descriptionKey,`settings.deck.${theme.id}.description`);
    assert.equal(theme.cards.length,54);assert.deepEqual(theme.cards.map(c=>c.name),specifications.map(c=>c.name));
    assert.equal(new Set(theme.cards.map(c=>parseCard(c.name).score)).size,54);
    const files=[...theme.cards.map(c=>c.front),theme.back,theme.preview];assert.equal(new Set(files).size,56);
    const hashes=new Set();
    for(const [i,file]of files.entries()){
      assert.ok(file.startsWith(`assets/action-decks/${theme.id}/`));assert.ok(!file.includes('..'));assert.ok(!path.isAbsolute(file));
      const absolute=path.resolve(packageRoot,file);assert.ok(absolute.startsWith(packageRoot+path.sep));
      const info=await stat(absolute);assert.ok(info.size>1500);assert.ok(info.size<=10_485_760);
      const bytes=await readFile(absolute);assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
      hashes.add(bytes.toString('base64'));
    }
    assert.equal(hashes.size,56,'No repeated placeholder faces/back/preview');
  }
  assert.ok(WIDTH*HEIGHT<=16_000_000);
});

test('build proof records the rendered numeric pip counts for every suit in every theme',async()=>{
  const proof=await readJson(path.join(packageRoot,'tests/fixtures/action-deck-build-proof.json'));
  assert.deepEqual(proof.dimensions,[600,900]);
  for(const theme of proof.themes){assert.equal(theme.count,54);for(const card of theme.cards){const parsed=parseCard(card.name);assert.equal(card.pips,parsed.joker?0:parsed.rank===14?1:parsed.rank<=10?parsed.rank:0);assert.equal((await stat(path.join(packageRoot,'assets/action-decks',theme.id,card.file))).size,card.bytes);}}
});
