import { useState, useCallback, useEffect } from "react";

// ─── load pdf.js via script tag onto window ───────────────────────────────────
function loadPdfJs() {
  return new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error("Falha ao carregar pdf.js"));
    document.head.appendChild(script);
  });
}

async function extractTextFromPDF(file) {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    fullText += content.items.map((i) => i.str).join(" ") + "\n";
  }
  return fullText;
}

function parse894FromText(text) {
  const pattern =
    /C[oó]digo\s+CTB[:\s]+(\d+)\s+Fonte\s+de\s+Recurso[:\s]+(\d+).*?balancete\s+cont[aá]bil[:\s]+([-\d.]+).*?acompanhamento\s+mensal[:\s]+([-\d.]+)/gi;
  const results = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    results.push({
      ctb: m[1].trim(),
      fonte: m[2].trim(),
      balancete: m[3].trim(),
      acompanhamento: m[4].trim(),
    });
  }
  return results;
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function parseDotFloat(str) {
  if (!str || str.trim() === "" || str.trim() === ".00") return 0;
  return parseFloat(str) || 0;
}
function parseBRFloat(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/\./g, "").replace(",", ".")) || 0;
}
function formatBRFloat(num) {
  return Math.abs(num).toFixed(2).replace(".", ",");
}
function signedValue(valStr, nat) {
  const val = parseBRFloat(valStr);
  return nat.trim() === "C" ? -val : val;
}
function toNatural(signed) {
  return signed >= 0
    ? { val: formatBRFloat(signed), nat: "D" }
    : { val: formatBRFloat(-signed), nat: "C" };
}
function parseCSV(text) {
  return text.split(/\r?\n/).map((l) => l.split(";"));
}
function serializeCSV(rows) {
  return rows.map((r) => r.join(";")).join("\n");
}

// ─── app ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [step, setStep] = useState(1);
  const [csvRows, setCsvRows] = useState(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [parsedErrors, setParsedErrors] = useState([]);
  const [corrections, setCorrections] = useState({});
  const [correctedCSV, setCorrectedCSV] = useState("");
  const [stats, setStats] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [pdfFileName, setPdfFileName] = useState("");

  const handleCSVUpload = useCallback((e) => {
    const file = e.target.files[0];
    if (!file) return;
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvRows(parseCSV(ev.target.result)); setStep(2); };
    reader.readAsText(file, "latin1");
  }, []);

  const handlePDFUpload = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPdfFileName(file.name);
    setPdfError("");
    setPdfLoading(true);
    try {
      const text = await extractTextFromPDF(file);
      const errors = parse894FromText(text);
      if (errors.length === 0) {
        setPdfError("Nenhum erro 894 encontrado. Verifique se é o relatório correto do TCEMG.");
        setPdfLoading(false);
        return;
      }
      const init = {};
      errors.forEach((err) => {
        init[`${err.ctb}:${err.fonte}`] = parseDotFloat(err.acompanhamento);
      });
      setParsedErrors(errors);
      setCorrections(init);
      setStep(3);
    } catch (err) {
      setPdfError(`Erro ao ler o PDF: ${err.message}`);
    }
    setPdfLoading(false);
  }, []);

  const applyCorrections = useCallback(() => {
    if (!csvRows) return;
    const rows = csvRows.map((r) => [...r]);
    let type17Fixed = 0;
    const affectedContas = new Set();

    // Contas excluídas da soma 1.1.1 para o erro 894
    const EXCLUIDAS = new Set([
      "1.1.1.1.1.01.00",
      "1.1.1.1.1.02.00",
      "1.1.1.2.1.01.00",
      "1.1.1.1.2.00.00",
    ]);
    function isContaExcluida(conta) {
      return EXCLUIDAS.has(conta) || conta.startsWith("1.1.1.3");
    }
    function isContaBase(conta) {
      return conta.startsWith("1.1.1") && !isContaExcluida(conta);
    }

    // Para cada erro 894 (ctb+fonte), calcular:
    //   soma_balancete = soma dos saldo_final das contas 1.1.1 elegíveis no CSV (tipo 17, mesmo ctb+fonte)
    //   diferença = AM - soma_balancete
    //   lançar a diferença na PRIMEIRA linha tipo 17 com esse ctb+fonte (qualquer conta)
    //   via: novo_saldo_final = saldo_final_atual + diferença

    const keysToFix = new Set(Object.keys(corrections));

    for (const key of keysToFix) {
      const [ctb, fonte] = key.split(":");
      const amValue = corrections[key]; // valor AM (signed)

      // 1. Somar saldos finais das contas 1.1.1 elegíveis para esse ctb+fonte
      let somaBalancete = 0;
      for (const r of rows) {
        if (r[0] !== "17") continue;
        if (r[4] !== ctb || r[5] !== fonte) continue;
        if (!isContaBase(r[1])) continue;
        somaBalancete += signedValue(r[11], r[12]);
      }

      // 2. Diferença a lançar
      const diff = amValue - somaBalancete;
      if (Math.abs(diff) < 0.005) continue; // sem ajuste necessário

      // 3. Primeira linha tipo 17 com esse ctb+fonte (qualquer conta)
      // Campos tipo 17: [7]=saldo_ini [8]=nat_ini [9]=debito [10]=credito [11]=saldo_final [12]=nat_final
      // saldo_final = saldo_inicial(signed) + debito - credito
      // Para ajustar o saldo_final sem alterar o saldo_inicial:
      //   diff > 0 → aumentar débito em |diff|
      //   diff < 0 → aumentar crédito em |diff|
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r[0] !== "17") continue;
        if (r[4] !== ctb || r[5] !== fonte) continue;

        const saldoAtual = signedValue(r[11], r[12]);
        const novoSaldo = saldoAtual + diff;

        // Atualizar saldo_final
        const { val: sfVal, nat: sfNat } = toNatural(novoSaldo);
        rows[i][11] = sfVal;
        rows[i][12] = sfNat;

        // Ajustar débito ou crédito conforme o sinal da diferença
        if (diff > 0) {
          // saldo aumentou → soma diff no débito
          const debitoAtual = parseBRFloat(r[9]);
          rows[i][9] = formatBRFloat(debitoAtual + diff);
        } else {
          // saldo diminuiu → soma |diff| no crédito
          const creditoAtual = parseBRFloat(r[10]);
          rows[i][10] = formatBRFloat(creditoAtual + Math.abs(diff));
        }

        type17Fixed++;
        affectedContas.add(r[1]);
        break; // apenas a primeira ocorrência
      }
    }

    // Recalcular tipo 10 para contas afetadas
    // Tipo 10 campos: [3]=saldo_ini [4]=nat_ini [5]=debito [6]=credito [7]=saldo_final [8]=nat_final
    // A soma dos tipo 17 nos dá o novo saldo_final esperado do tipo 10
    // Ajustamos débito ou crédito do tipo 10 para refletir a diferença
    const contaSums = {};
    for (const r of rows) {
      if (r[0] !== "17") continue;
      if (!affectedContas.has(r[1])) continue;
      contaSums[r[1]] = (contaSums[r[1]] || 0) + signedValue(r[11], r[12]);
    }

    let type10Fixed = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r[0] !== "10" || !affectedContas.has(r[1])) continue;

      const saldoAtual10 = signedValue(r[7], r[8]);
      const novoSaldo10 = contaSums[r[1]] || 0;
      const diff10 = novoSaldo10 - saldoAtual10;

      // Atualizar saldo_final
      const { val: sfVal10, nat: sfNat10 } = toNatural(novoSaldo10);
      rows[i][7] = sfVal10;
      rows[i][8] = sfNat10;

      // Ajustar débito ou crédito do tipo 10
      if (Math.abs(diff10) >= 0.005) {
        if (diff10 > 0) {
          rows[i][5] = formatBRFloat(parseBRFloat(r[5]) + diff10);
        } else {
          rows[i][6] = formatBRFloat(parseBRFloat(r[6]) + Math.abs(diff10));
        }
      }

      type10Fixed++;
    }

    setCorrectedCSV(serializeCSV(rows));
    setStats({ type17Fixed, type10Fixed, contas: affectedContas.size });
    setStep(4);
  }, [csvRows, corrections]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([correctedCSV], { type: "text/csv;charset=latin1" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${csvFileName.replace(/\.csv$/i, "")}_CORRIGIDO.CSV`;
    a.click();
    URL.revokeObjectURL(url);
  }, [correctedCSV, csvFileName]);

  const reset = () => {
    setStep(1); setCsvRows(null); setParsedErrors([]);
    setCorrections({}); setCorrectedCSV(""); setPdfFileName("");
    setPdfError(""); setPdfLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", color: "#e6edf3", fontFamily: "'Courier New', monospace", padding: "32px 24px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <div style={{ background: "#1f6feb", borderRadius: 4, padding: "4px 10px", fontSize: 11, fontWeight: 700, letterSpacing: 2, color: "#fff" }}>TCEMG</div>
          <span style={{ color: "#8b949e", fontSize: 12 }}>Balancete · Erro 894</span>
        </div>
        <h1 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 700, color: "#f0f6fc" }}>Corretor de Balancete</h1>
        <p style={{ margin: "0 0 32px", color: "#8b949e", fontSize: 13 }}>
          Lê o relatório PDF do TCEMG, corrige os registros tipo&nbsp;17 e recalcula os totalizadores tipo&nbsp;10.
        </p>

        <Steps current={step} />

        {/* STEP 1 */}
        {step === 1 && (
          <Card title="1 · Carregar o BALANCETE.CSV">
            <p style={{ color: "#8b949e", fontSize: 13, marginBottom: 20 }}>Selecione o arquivo CSV exportado do seu sistema contábil para o TCEMG.</p>
            <DropZone icon="📂" label="Clique para selecionar" sub="Arquivo .CSV do BALANCETE" accept=".csv,.CSV" onChange={handleCSVUpload} />
          </Card>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <Card title="2 · Carregar o relatório de erros (PDF)">
            <p style={{ color: "#484f58", fontSize: 12, marginBottom: 20 }}>
              ✅ CSV carregado: <span style={{ color: "#7ee787" }}>{csvFileName}</span>
            </p>

            {pdfLoading ? (
              <div style={{ textAlign: "center", padding: "48px 0" }}>
                <Spinner />
                <p style={{ color: "#8b949e", fontSize: 13, marginTop: 16 }}>Lendo PDF e extraindo erros 894…</p>
              </div>
            ) : (
              <DropZone icon="📄" label="Clique para selecionar" sub="Relatório Informativo de Envio (.PDF)" accept=".pdf,.PDF" onChange={handlePDFUpload} />
            )}

            {pdfError && (
              <div style={{ marginTop: 16, background: "#2d0f0f", border: "1px solid #f85149", borderRadius: 6, padding: "10px 14px", color: "#f85149", fontSize: 13 }}>
                ⚠️ {pdfError}
              </div>
            )}
            <div style={{ marginTop: 16 }}><Btn onClick={() => setStep(1)} secondary>← Voltar</Btn></div>
          </Card>
        )}

        {/* STEP 3 */}
        {step === 3 && (() => {
          const EXCL = new Set(["1.1.1.1.1.01.00","1.1.1.1.1.02.00","1.1.1.2.1.01.00","1.1.1.1.2.00.00"]);
          const isBase = (c) => c.startsWith("1.1.1") && !EXCL.has(c) && !c.startsWith("1.1.1.3");
          const somasCSV = {};
          if (csvRows) {
            for (const r of csvRows) {
              if (r[0] !== "17") continue;
              if (!isBase(r[1])) continue;
              const k = `${r[4]}:${r[5]}`;
              somasCSV[k] = (somasCSV[k] || 0) + signedValue(r[11], r[12]);
            }
          }
          return (
            <Card title={`3 · Revisar — ${parsedErrors.length} erros 894 encontrados`}>
              <p style={{ color: "#8b949e", fontSize: 13, marginBottom: 4 }}>
                A diferença entre <strong style={{ color: "#7ee787" }}>Acomp. Mensal</strong> e a soma das contas 1.1.1 no CSV será lançada na 1ª linha tipo&nbsp;17 do CTB+Fonte.
              </p>
              <p style={{ color: "#484f58", fontSize: 12, marginBottom: 16 }}>📄 {pdfFileName}</p>
              <div style={{ overflowX: "auto", maxHeight: 400, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["CTB", "Fonte", "Soma 1.1.1 (CSV)", "AM (correto)", "Diferença"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "6px 10px", fontSize: 10, color: "#484f58", textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #21262d", fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsedErrors.map((err) => {
                      const key = `${err.ctb}:${err.fonte}`;
                      const current = corrections[key] ?? 0;
                      const { val: displayVal, nat: displayNat } = toNatural(current);
                      const somaCSV = somasCSV[key] || 0;
                      const diff = current - somaCSV;
                      const { val: diffVal, nat: diffNat } = toNatural(diff);
                      const hasDiff = Math.abs(diff) > 0.005;
                      return (
                        <tr key={key} style={{ background: hasDiff ? "#0d2439" : "#161b22", borderBottom: "1px solid #1c2128" }}>
                          <td style={{ padding: "5px 10px", color: "#e6edf3" }}>{err.ctb}</td>
                          <td style={{ padding: "5px 10px", color: "#e6edf3" }}>{err.fonte}</td>
                          <td style={{ padding: "5px 10px", color: "#f85149", fontFamily: "'Courier New', monospace" }}>
                            {formatBRFloat(Math.abs(somaCSV))} {somaCSV < 0 ? "C" : "D"}
                          </td>
                          <td style={{ padding: "4px 8px" }}>
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              <input
                                type="text"
                                value={displayVal}
                                onChange={(e) => {
                                  const v = parseBRFloat(e.target.value);
                                  setCorrections((prev) => ({ ...prev, [key]: displayNat === "C" ? -v : v }));
                                }}
                                style={{ width: 100, background: "#0d1117", border: "1px solid #30363d", borderRadius: 4, padding: "3px 7px", color: "#7ee787", fontFamily: "'Courier New', monospace", fontSize: 12 }}
                              />
                              <select
                                value={displayNat}
                                onChange={(e) => {
                                  const nat = e.target.value;
                                  setCorrections((prev) => {
                                    const abs = Math.abs(prev[key] || 0);
                                    return { ...prev, [key]: nat === "C" ? -abs : abs };
                                  });
                                }}
                                style={{ background: "#21262d", border: "1px solid #30363d", color: "#e6edf3", borderRadius: 4, padding: "3px 5px", fontSize: 12 }}
                              >
                                <option value="D">D</option>
                                <option value="C">C</option>
                              </select>
                            </div>
                          </td>
                          <td style={{ padding: "5px 10px", color: hasDiff ? "#f0883e" : "#484f58", fontFamily: "'Courier New', monospace" }}>
                            {hasDiff ? `${diffNat === "C" ? "−" : "+"}${diffVal} ${diffNat}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <Btn onClick={() => setStep(2)} secondary>← Voltar</Btn>
                <Btn onClick={applyCorrections}>Gerar CSV corrigido →</Btn>
              </div>
            </Card>
          );
        })()}


        {/* STEP 4 */}
        {step === 4 && stats && (
          <Card title="4 · CSV corrigido pronto!">
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
              <StatRow icon="✏️" label="Registros tipo 17 corrigidos" value={stats.type17Fixed} />
              <StatRow icon="🔢" label="Totalizadores tipo 10 recalculados" value={stats.type10Fixed} />
              <StatRow icon="📋" label="Contas contábeis afetadas" value={stats.contas} />
            </div>
            <div style={{ background: "#0d2039", border: "1px solid #238636", borderRadius: 8, padding: "14px 18px", marginBottom: 24, fontSize: 13, color: "#7ee787" }}>
              ✅ Apenas os registros dos erros 894 foram alterados — todo o restante permanece idêntico ao original.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn onClick={handleDownload}>⬇️ Baixar CSV corrigido</Btn>
              <Btn onClick={reset} secondary>🔄 Novo arquivo</Btn>
            </div>
          </Card>
        )}

      </div>
    </div>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────
function Steps({ current }) {
  const labels = ["CSV", "PDF", "Revisar", "Baixar"];
  return (
    <div style={{ display: "flex", marginBottom: 36 }}>
      {[1, 2, 3, 4].map((n) => (
        <div key={n} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, position: "relative" }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", border: `2px solid ${current >= n ? "#1f6feb" : "#30363d"}`, background: "#0d1117", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: current >= n ? "#1f6feb" : "#484f58", zIndex: 1, position: "relative" }}>
            {current > n ? "✓" : n}
          </div>
          {n < 4 && <div style={{ position: "absolute", top: 13, left: "50%", right: "-50%", height: 2, background: current > n ? "#1f6feb" : "#21262d", zIndex: 0 }} />}
          <span style={{ fontSize: 10, color: current === n ? "#1f6feb" : "#484f58", textTransform: "uppercase", letterSpacing: 1 }}>{labels[n - 1]}</span>
        </div>
      ))}
    </div>
  );
}

function DropZone({ icon, label, sub, accept, onChange }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "2px dashed #30363d", borderRadius: 8, padding: "48px 24px", cursor: "pointer", background: "#161b22", transition: "border-color .2s" }}
      onMouseEnter={(e) => e.currentTarget.style.borderColor = "#1f6feb"}
      onMouseLeave={(e) => e.currentTarget.style.borderColor = "#30363d"}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }}>{icon}</div>
      <span style={{ color: "#1f6feb", fontWeight: 600, fontSize: 14 }}>{label}</span>
      <span style={{ color: "#484f58", fontSize: 12, marginTop: 4 }}>{sub}</span>
      <input type="file" accept={accept} onChange={onChange} style={{ display: "none" }} />
    </label>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 10, padding: "24px 28px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 700, color: "#f0f6fc" }}>{title}</h2>
      {children}
    </div>
  );
}

function Btn({ children, onClick, secondary }) {
  return (
    <button onClick={onClick} style={{ padding: "8px 20px", borderRadius: 6, border: secondary ? "1px solid #30363d" : "none", background: secondary ? "transparent" : "#1f6feb", color: secondary ? "#8b949e" : "#fff", fontFamily: "'Courier New', monospace", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
      onMouseEnter={(e) => e.currentTarget.style.opacity = "0.8"}
      onMouseLeave={(e) => e.currentTarget.style.opacity = "1"}
    >
      {children}
    </button>
  );
}

function StatRow({ icon, label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#0d1117", borderRadius: 6 }}>
      <span style={{ color: "#8b949e", fontSize: 13 }}>{icon} {label}</span>
      <span style={{ color: "#f0f6fc", fontWeight: 700, fontSize: 16, fontFamily: "'Courier New', monospace" }}>{value}</span>
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ width: 32, height: 32, border: "3px solid #30363d", borderTop: "3px solid #1f6feb", borderRadius: "50%", margin: "0 auto", animation: "spin 0.8s linear infinite" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
