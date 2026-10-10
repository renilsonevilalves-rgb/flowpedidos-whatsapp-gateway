// tests/chat-dialogue.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readInquiry, searchCatalog, mayBeCartAddition } from "../dist/chatDialogue.js";

const products = [
  { id:"pudim",name:"Pudim",price:12,optionGroups:[] },
  { id:"bacon",name:"X-Egg Bacon",price:32,optionGroups:[] },
  { id:"cola350",name:"Coca cola 350ml",price:6,optionGroups:[] },
  { id:"cola2l",name:"Coca cola 2L",price:14,optionGroups:[] },
];

test("questions strip politeness and 'também' before checking the real menu", () => {
  assert.deepEqual(readInquiry("Tem pudim também?"), {type:"availability",query:"pudim"});
  assert.deepEqual(readInquiry("Quero saber se tem de Bacon?"), {type:"availability",query:"bacon"});
  assert.deepEqual(readInquiry("Tem de Bacon? Se tiver quero trocar"), {type:"availability",query:"bacon"});
  assert.deepEqual(readInquiry("Vocês vendem pudim?"), {type:"availability",query:"pudim"});
  assert.deepEqual(readInquiry("Pudim tem aí?"), {type:"availability",query:"pudim"});
  assert.deepEqual(readInquiry("Qual o valor do pudim?"), {type:"price",query:"pudim"});
  assert.deepEqual(readInquiry("Não tem?", "pudim"), {type:"followup",query:"pudim"});
  assert.deepEqual(readInquiry("Tem certeza?", "pudim"), {type:"followup",query:"pudim"});
});

test("product matching never includes discourse particles in catalog names", () => {
  assert.deepEqual(searchCatalog("pudim",products).products.map(x=>x.id), ["pudim"]);
  assert.deepEqual(searchCatalog("de bacon",products).products.map(x=>x.id), ["bacon"]);
  assert.deepEqual(searchCatalog("coca cola",products).products.map(x=>x.id), ["cola350","cola2l"]);
  assert.deepEqual(searchCatalog("pirulito",products).products, []);
});

test("only genuine addition statements are candidates for deterministic cart updates", () => {
  assert.equal(mayBeCartAddition("Quero um pudim também"), true);
  assert.equal(mayBeCartAddition("Acrescenta mais um pudim"), true);
  assert.equal(mayBeCartAddition("Tem pudim também?"), false);
  assert.equal(mayBeCartAddition("Tem pudim? Se tiver quero trocar"), false);
  assert.equal(mayBeCartAddition("Quero saber se tem pudim"), false);
  assert.equal(mayBeCartAddition("Troca o pudim pelo lanche"), false);
});
