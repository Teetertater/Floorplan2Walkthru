export function initPlanPicker(
  selectEl: HTMLSelectElement,
  plans: { id: string; name: string }[],
  onChange: (planId: string) => void,
): void {
  for (const plan of plans) {
    const opt = document.createElement('option');
    opt.value = plan.id;
    opt.textContent = plan.name;
    selectEl.appendChild(opt);
  }

  selectEl.addEventListener('change', () => {
    onChange(selectEl.value);
  });
}
