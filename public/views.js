(() => {
  if(document.body.dataset.page!=='dashboard')return;
  const names=['gpu','cpu','memory','slurm','history'];
  let selected='gpu';
  try{const saved=sessionStorage.getItem('monitor-view');if(names.includes(saved))selected=saved;}catch{}
  function select(view){
    for(const name of names){
      document.getElementById(name+'-panel').hidden=name!==view;
      const button=document.getElementById('view-'+name);
      button.classList.toggle('selected',name===view);button.setAttribute('aria-pressed',String(name===view));
    }
    window.monitorActiveView=view;
    try{sessionStorage.setItem('monitor-view',view);}catch{}
    document.dispatchEvent(new CustomEvent('monitor-view',{detail:view}));
  }
  for(const name of names)document.getElementById('view-'+name).addEventListener('click',()=>select(name));
  select(selected);
})();
