"""Protocol clients. Only fixed sandbox-launcher commands are accepted by the caller."""
import json,uuid,time
from broker import Rpc,Denied

def uuid7():
    # MSP commandId requires UUIDv7, not an arbitrary reused session identifier.
    bits=(int(time.time()*1000)<<80)|(7<<76)|((uuid.uuid4().int>>64 & 0xfff)<<64)|(2<<62)|(uuid.uuid4().int & ((1<<62)-1))
    return str(uuid.UUID(int=bits))

def prompt_text(data):
    # Preserve roles as data; tools and resource/skill parts are never admitted.
    return json.dumps({'messages':data['messages'],'maxOutputTokens':data['maxOutputTokens'],
        'responseFormat':data.get('responseFormat')},ensure_ascii=False)

def minimax(data,command):
    rpc=Rpc(command)
    try:
        result=rpc.call('initialize',dict(protocolVersion=1,clientCapabilities=dict(fs=dict(readTextFile=False,writeTextFile=False),terminal=False),clientInfo=dict(name='st_code_cli',version='1')))
        if result.get('protocolVersion')!=1:raise Denied('unsupported ACP version')
        session=rpc.call('session/new',dict(cwd='/work',mcpServers=[]))
        sid=session.get('sessionId')
        if not isinstance(sid,str):raise Denied('missing ACP session')
        # No silent CLI-default model: the selected model must be advertised and set.
        options=session.get('configOptions',[])
        model_option=next((o for o in options if o.get('category')=='model'),None)
        if not model_option:raise Denied('model configuration not advertised by ACP')
        values=model_option.get('options',[])
        target=next((o.get('value') for o in values if o.get('value')==f"m:minimax:{data['model']}:v:"),None)
        if not target:raise Denied('requested model not advertised by ACP')
        rpc.call('session/set_config_option',dict(sessionId=sid,configId=model_option['id'],value=target))
        rpc.call('session/set_config_option',dict(sessionId=sid,configId='permissionMode',value='default'))
        rpc.events.clear()
        result=rpc.call('session/prompt',dict(sessionId=sid,prompt=[dict(type='text',text=prompt_text(data))]))
        text=''.join(e.get('params',{}).get('update',{}).get('content',{}).get('text','') for e in rpc.events
          if e.get('params',{}).get('sessionId')==sid and e.get('params',{}).get('update',{}).get('sessionUpdate')=='agent_message_chunk')
        reason=result.get('stopReason')
        if reason not in ('end_turn','max_tokens'):raise Denied('ACP turn did not finish')
        return dict(version=1,text=text,finishReason='length' if reason=='max_tokens' else 'stop')
    finally:rpc.close()

def muse(data,command):
    rpc=Rpc(command)
    try:
        rpc.call('initialize',dict(clientInfo=dict(name='st_code_cli',version='1'),capabilities=dict(requestedCapabilities=[],userInputDialogs=False)))
        rpc.send('initialized',notification=True)
        result=rpc.call('session/start',dict(commandId=uuid7(),workspaceRoot='/work',providerId='meta',modelId=data['model'],approvalMode='denyUnmatched',config=dict(mcpServers={})))
        session=result.get('session',{});sid=session.get('sessionId') or session.get('id')
        if not isinstance(sid,str):raise Denied('missing MSP session')
        rpc.events.clear()
        rpc.call('turn/start',dict(commandId=uuid7(),sessionId=sid,input=[dict(type='text',text=prompt_text(data))]))
        terminal=None
        while terminal is None:
            for event in rpc.events:
                if event.get('method')=='turn/completed' and event.get('params',{}).get('sessionId')==sid:terminal=event['params']
            if terminal is None:rpc.read()
        if terminal.get('terminal')!='completed':raise Denied('MSP turn did not finish')
        items=[e.get('params',{}).get('item',{}) for e in rpc.events if e.get('method')=='item/completed' and e.get('params',{}).get('sessionId')==sid]
        text=''.join(i.get('text','') for i in items if i.get('kind')=='agentMessage')
        return dict(version=1,text=text,finishReason='stop')
    finally:rpc.close()
