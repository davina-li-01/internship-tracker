/**
 * Attachment type rules — photos of handwritten notes must be accepted.
 * Loads the real js/main.js through the same stub harness.
 */
import { loadMain } from "./helpers/load-main.mjs";
const __t = await loadMain();

let pass=0, fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log(`${ok?"  ok":"FAIL"}  ${n}${ok?"":`  got ${JSON.stringify(g)}`}`)};
const ok=(n,c)=>eq(n,Boolean(c),true);
const f=(name,type="")=>({name,type});

console.log("\nAttachments — what is accepted");
ok("a PDF", __t.isAllowedAttachment(f("notes.pdf","application/pdf")));
ok("a phone photo (JPEG)", __t.isAllowedAttachment(f("IMG_4821.jpg","image/jpeg")));
ok("a screenshot (PNG)", __t.isAllowedAttachment(f("Screenshot.png","image/png")));
ok("HEIC, which is what an iPhone shoots by default",
   __t.isAllowedAttachment(f("IMG_4821.HEIC","image/heic")));
ok("HEIC even when the browser reports no type",
   __t.isAllowedAttachment(f("IMG_4821.HEIC","")));
ok("a PDF with no reported type", __t.isAllowedAttachment(f("scan.pdf","")));

console.log("\nAttachments — what is refused");
ok("a Word document", !__t.isAllowedAttachment(f("notes.docx","application/vnd.openxmlformats-officedocument.wordprocessingml.document")));
ok("a zip", !__t.isAllowedAttachment(f("stuff.zip","application/zip")));
ok("an executable", !__t.isAllowedAttachment(f("bad.exe","application/x-msdownload")));
ok("nothing at all", !__t.isAllowedAttachment(null));

console.log("\nAttachments — the accept attribute offers both");
ok("PDFs", __t.ATTACH_ACCEPT.includes("application/pdf"));
ok("images", __t.ATTACH_ACCEPT.includes("image/*"));
ok("and HEIC by extension, which image/* misses", __t.ATTACH_ACCEPT.includes(".heic"));

console.log("\nPreviews — an image is not an <object type=pdf>");
{
  const img = __t.renderStorageFileCard({ id:"1", name:"IMG_4821.jpg", fileUrl:"https://cdn.test/IMG_4821.jpg" }, null);
  ok("photos render as <img>", img.includes("doc-preview-img") && img.includes("<img"));
  ok("and not as a PDF object", !img.includes('type="application/pdf"'));

  const pdf = __t.renderStorageFileCard({ id:"2", name:"resume.pdf", fileUrl:"https://cdn.test/resume.pdf" }, null);
  ok("PDFs keep the native object preview", pdf.includes('type="application/pdf"'));
  ok("and are not put in an <img>", !pdf.includes("doc-preview-img"));

  const none = __t.renderStorageFileCard({ id:"3", name:"x.pdf", fileUrl:"" }, null);
  ok("a file with no url falls back", none.includes("doc-preview-fallback"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
