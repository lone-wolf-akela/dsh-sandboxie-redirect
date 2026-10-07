// Offline reproduction of the chip's state machine, using the REAL projection
// definition: does a state cleared by `sandbox_clear` re-derive the box on the
// next committed event? (It should; the live chip did not come back.)
import * as host from "../lib/host.mjs";

const WS = "C:\\Users\\liuruoyang\\Documents\\deepseek-harness\\default-workspace";
let definition;
await host.apply({
  effect: () => () => {},
  sessionProjections: {
    register: (value) => {
      definition = value;
      return () => {};
    }
  }
});

console.log("currentBoxFor      :", JSON.stringify(host.currentBoxFor(WS)));
console.log("init(header)       :", JSON.stringify(definition.init({ cwd: WS }, 0)));

const cleared = { cwd: WS, box: null, root: null };
for (const type of ["tool/result", "user/message", "turn/start"]) {
  const next = definition.apply(cleared, { type, seq: 1, time: Date.now(), data: {} });
  console.log(`apply(${type.padEnd(12)}) ->`, JSON.stringify(next), next === cleared ? "(same reference)" : "(NEW reference)");
}
console.log("wire.view(cleared) :", JSON.stringify(definition.wire.view(cleared)));
const rederived = definition.apply(cleared, { type: "tool/result", seq: 1, time: Date.now(), data: {} });
console.log("wire.view(apply)   :", JSON.stringify(definition.wire.view(rederived)));
console.log("stateVersion       :", definition.stateVersion);
