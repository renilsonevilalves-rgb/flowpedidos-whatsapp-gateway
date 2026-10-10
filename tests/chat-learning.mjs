// tests/chat-learning.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  validAlias, explicitProductCorrection, applyApprovedAliases,
} from "../dist/chatLearning.js";

const products = [
  { id: "product-x", name: "X Tudo" },
  { id: "product-b", name: "X Egg Bacon" },
  { id: "product-350", name: "Coca Cola 350ml" },
  { id: "product-2l", name: "Coca Cola 2L" },
];

test("captures only explicit equivalence to exact catalog item", () => {
  assert.deepEqual(explicitProductCorrection("Não, xtudão é X Tudo", products),
    { alias: "xtudao", productId: "product-x" });
  assert.deepEqual(explicitProductCorrection("quando eu falo xtudao quero dizer X Tudo", products),
    { alias: "xtudao", productId: "product-x" });
  assert.equal(explicitProductCorrection("troca X Tudo por X Egg Bacon", products), null);
  assert.equal(explicitProductCorrection("xtudao é produto inventado", products), null);
  assert.equal(explicitProductCorrection("rua 5 é X Tudo", products), null);
  assert.equal(explicitProductCorrection("x tudo é X Egg Bacon", products), null);
});

test("approved aliases apply only to the authorized and active product catalog", () => {
  const approved = [{ alias: "xtudao", productId: "product-x" }];
  assert.match(applyApprovedAliases("Quero dois xtudão", approved, products), /dois x tudo/);
  assert.equal(applyApprovedAliases("Quero xtudão", [], products), "Quero xtudão");
  assert.equal(applyApprovedAliases("Quero xtudão", [{ alias: "xtudao", productId: "other-store" }], products),
    "quero xtudao");
  assert.equal(applyApprovedAliases("Quero superxtudao", approved, products), "quero superxtudao");
});

test("ambiguous aliases or real product names never substitute catalog products", () => {
  assert.equal(validAlias("coca cola", "product-350", products), "");
  const conflict = [
    { alias: "xtudao", productId: "product-x" },
    { alias: "xtudao", productId: "product-b" },
  ];
  assert.equal(applyApprovedAliases("Quero xtudao", conflict, products), "quero xtudao");
});
