export async function waitForResponse(promise, label) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}
