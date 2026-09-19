/** Runs before paint to apply stored theme and avoid a light flash. */
export function ThemeScript() {
  const code = `(function(){try{var t=localStorage.getItem("aquin-theme");if(t!=="dark"&&t!=="light")t="light";var r=document.documentElement;r.classList.toggle("dark",t==="dark");r.style.colorScheme=t;}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
