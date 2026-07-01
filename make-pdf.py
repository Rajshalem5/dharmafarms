import markdown
from weasyprint import HTML
import os

md_path = r"C:\Users\vajra\OneDrive\Desktop\mini project\DHARMA-FARMS-SRD-v2.md"
with open(md_path, 'r', encoding='utf-8') as f:
    md_content = f.read()

html_body = markdown.markdown(
    md_content,
    extensions=['tables', 'fenced_code', 'codehilite', 'sane_lists', 'nl2br']
)

S = lambda s: s.replace('{', '{{').replace('}', '}}')  # escape curly braces for f-string CSS issue
# Actually, let me use a raw string approach instead
html_doc = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>\n'
html_doc += """
  @page {
    size: A4;
    margin: 2cm 2.5cm;
    @top-center { content: "DHARMA FARMS - SRD v2.0"; font-size: 9pt; color: #666; font-family: 'Segoe UI', Arial, sans-serif; }
    @bottom-center { content: "Page " counter(page); font-size: 9pt; color: #666; font-family: 'Segoe UI', Arial, sans-serif; }
  }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 22pt; color: #1a3a1a; border-bottom: 3px solid #2d6a2d; padding-bottom: 8px; margin-top: 30px; }
  h2 { font-size: 16pt; color: #2d6a2d; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-top: 24px; }
  h3 { font-size: 13pt; color: #3a3a3a; margin-top: 18px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 9.5pt; }
  th { background: #2d6a2d; color: white; padding: 8px 10px; text-align: left; font-weight: 600; }
  td { padding: 6px 10px; border: 1px solid #ddd; }
  tr:nth-child(even) { background: #f5f8f5; }
  code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; font-size: 9pt; font-family: 'Consolas', monospace; }
  pre { background: #f5f5f5; border: 1px solid #ddd; border-left: 4px solid #2d6a2d; padding: 10px 14px; font-size: 8.5pt; line-height: 1.4; white-space: pre-wrap; font-family: 'Consolas', monospace; }
  blockquote { border-left: 4px solid #2d6a2d; margin: 12px 0; padding: 8px 16px; background: #f0f7f0; font-style: italic; color: #333; }
  hr { border: none; border-top: 2px solid #2d6a2d; margin: 24px 0; }
  p { margin: 8px 0; text-align: justify; }
  ul, ol { margin: 6px 0; padding-left: 20px; }
  li { margin: 2px 0; }
  strong { color: #1a3a1a; }
</style>
</head>
<body>
""" + html_body + """
</body>
</html>"""

html_path = md_path.replace('.md', '.html')
with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html_doc)

pdf_path = md_path.replace('.md', '.pdf')
HTML(filename=html_path).write_pdf(pdf_path)
os.remove(html_path)

size = os.path.getsize(pdf_path) / 1024
print(f"PDF OK: {pdf_path}")
print(f"Size: {size:.0f} KB")