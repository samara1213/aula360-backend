/**
 * Plantilla del sistema: se usa cuando la institución no tiene una plantilla
 * activa. Va como texto en el código (no como asset) para que siempre esté en
 * el build. Sirve también de ejemplo del contrato v1 (ReportCardTemplateData).
 */
export const DEFAULT_REPORT_CARD_TEMPLATE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Boletín</title>
<style>
  @page { size: Letter; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #1f2937; font-size: 11px; margin: 0; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #1e3a8a; padding-bottom: 10px; }
  header img { width: 64px; height: 64px; object-fit: contain; }
  header h1 { font-size: 17px; margin: 0; color: #1e3a8a; }
  header p { margin: 2px 0 0; color: #4b5563; }
  .title { text-align: center; margin: 14px 0 10px; font-size: 14px; letter-spacing: .08em; text-transform: uppercase; color: #1e3a8a; }
  .info { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 16px; background: #f3f4f6; border-radius: 6px; padding: 10px 12px; }
  .info span { display: block; font-size: 9px; text-transform: uppercase; color: #6b7280; }
  .info strong { font-size: 11.5px; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th { background: #1e3a8a; color: #fff; font-weight: 600; text-align: left; padding: 7px 8px; font-size: 10px; text-transform: uppercase; }
  td { padding: 7px 8px; border-bottom: 1px solid #e5e7eb; }
  tr:nth-child(even) td { background: #f9fafb; }
  .num { text-align: center; width: 70px; }
  .level { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; background: #e5e7eb; }
  .level.superior { background: #dcfce7; color: #166534; }
  .level.alto { background: #dbeafe; color: #1e40af; }
  .level.basico { background: #fef9c3; color: #854d0e; }
  .level.bajo { background: #fee2e2; color: #991b1b; }
  .pending { color: #b45309; font-style: italic; }
  .summary { margin-top: 14px; display: flex; justify-content: flex-end; gap: 10px; align-items: center; font-size: 13px; }
  .summary strong { font-size: 18px; color: #1e3a8a; }
  .note { margin-top: 6px; text-align: right; color: #b45309; font-size: 10px; }
  .levels { margin-top: 18px; font-size: 9.5px; color: #6b7280; }
  footer { margin-top: 28px; display: flex; justify-content: space-between; color: #9ca3af; font-size: 9px; border-top: 1px solid #e5e7eb; padding-top: 6px; }
</style>
</head>
<body>
  <header>
    {{#if institution.logoDataUri}}<img src="{{institution.logoDataUri}}" alt="Logo">{{/if}}
    <div>
      <h1>{{institution.name}}</h1>
      <p>NIT {{institution.nit}}{{#if campus}} · {{campus.name}}{{/if}}</p>
    </div>
  </header>

  <div class="title">Informe académico · {{period.name}} · {{academicYear.year}}</div>

  <section class="info">
    <div><span>Estudiante</span><strong>{{student.firstName}} {{student.lastName}}</strong></div>
    <div><span>Documento</span><strong>{{student.documentType}} {{student.documentNumber}}</strong></div>
    <div><span>Curso</span><strong>{{course.grade}} · {{course.name}}</strong></div>
    <div><span>Periodo</span><strong>{{date period.startDate}} a {{date period.endDate}}</strong></div>
    <div><span>Escala</span><strong>{{score scale.min}} a {{score scale.max}}</strong></div>
    <div><span>Nota mínima aprobatoria</span><strong>{{score scale.passingScore}}</strong></div>
  </section>

  <table>
    <thead>
      <tr><th>Materia</th><th>Docente</th><th class="num">Nota</th><th>Desempeño</th></tr>
    </thead>
    <tbody>
      {{#each subjects}}
      <tr>
        <td>{{name}}</td>
        <td>{{#if teacher}}{{teacher}}{{else}}—{{/if}}</td>
        {{#if pending}}
        <td class="num pending">{{score accumulated}}*</td>
        <td class="pending">Pendiente</td>
        {{else}}
        <td class="num">{{score final}}</td>
        <td>{{#if level}}<span class="level {{levelClass level}}">{{level}}</span>{{else}}—{{/if}}</td>
        {{/if}}
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="summary">
    Promedio del periodo <strong>{{score average}}</strong>
    {{#if averageLevel}}<span class="level {{levelClass averageLevel}}">{{averageLevel}}</span>{{/if}}
  </div>
  {{#if averagePartial}}<div class="note">* Notas pendientes: se muestra el acumulado y el promedio es parcial.</div>{{/if}}

  {{#if levels.length}}
  <div class="levels">
    Niveles de desempeño:
    {{#each levels}}{{name}} ({{score minScore}} – {{score maxScore}}){{#unless @last}} · {{/unless}}{{/each}}
  </div>
  {{/if}}

  <footer>
    <span>Generado el {{date generatedAt}}</span>
    <span>Aula360</span>
  </footer>
</body>
</html>
`;
