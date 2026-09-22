import type {ProposalLedger} from "./proposals.js";
export const ownerPreferenceKey=(owner:string,key:string)=>`owner:${encodeURIComponent(owner)}:${key}`;
/** Legacy single-item dismissals must never become sender/topic suppression. */
export function preferencesForOwner(ledger:ProposalLedger,owner:string,now=new Date()){
 const prefix=ownerPreferenceKey(owner,"");
 return ledger.preferences(now).filter(r=>(!r.key.startsWith("owner:")||r.key.startsWith(prefix))&&!/:(?:ignored|not_important|rejected)$/.test(r.key));
}
