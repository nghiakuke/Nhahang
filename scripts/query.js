/**
 * Đọc JSON từ stdin và in ra giá trị theo biểu thức trỏ vào biến `j`.
 * Ví dụ:  curl ... | node scripts/query.js '.order.total'
 */
let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  const expr = process.argv[process.argv.length - 1];
  try {
    const parsed = JSON.parse(data);
    const evaluate = new Function("j", `return (j${expr})`);
    const value = evaluate(parsed);
    if (value === undefined || value === null) {
      process.stdout.write("ERR");
      return;
    }
    process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
  } catch (err) {
    process.stdout.write("ERR");
  }
});
